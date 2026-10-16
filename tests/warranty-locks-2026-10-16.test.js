/**
 * tests/warranty-locks-2026-10-16.test.js — warranty terms lock at signing,
 * and the warranty certificate wizard follows the estimate.
 *
 * WHY: Jo (2026-10-15): "an annual inspection, lock at signing". #2463 locked
 * the siding package (warrantyPackage) at signing and gave Elite siding the
 * annual courtesy inspection. This finishes the job:
 *   1. LOCK      repairWarranty (the 1-year repair box) locks at signing with
 *                the same signedPrice mechanism (customer-estimate-rows.js
 *                PRICED_FIELDS): a change after signing is an unsigned
 *                change, signedView puts the signed value back, and the
 *                certificate prints what was signed. Old signed estimates
 *                (a stamp made before this lock) read exactly as before, and
 *                an unticked estimate keeps the fingerprint it had.
 *   2. WIZARD    warranty-cert.js (the dashboard certificate wizard, which
 *                writes lead.warranty for the portal's warranty card) takes
 *                the tier / siding package / job-type years from the lead's
 *                estimate (signed copy when it changed after signing) and
 *                locks the pick. Manual pick only when there is no estimate.
 *   3. PRODUCT   the certificate's manufacturer disclaimer names shingles only
 *                on a roof; siding Elite keeps the annual inspection.
 *   4. CUSTOMER  customer.html's certificate reads the signed copy too.
 *   5. AGENTS    WORKMANSHIP_YEARS (agents' rules reference): siding by
 *                package, gutters 5, guards 2, repairs 1.
 *
 * Run: node tests/warranty-locks-2026-10-16.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(name) { console.log('\n' + name); }

const ROWS = require(path.join(ROOT, 'docs/pro/js/customer-estimate-rows.js'));
const ROWS_FN = require(path.join(ROOT, 'functions/customer-estimate-rows.js'));

// A signature as the server stamps it (functions/signed-price.js planSignedStamp).
function sign(api, est) {
  const fields = api.signedPriceSnapshot(est);
  return Object.assign({}, est, { signedPrice: { fields, fingerprint: api.pricedFingerprint(fields), totalCents: 50000 } });
}
// A stamp made BEFORE the repair lock: its fields have no repairWarranty key
// and its fingerprint was taken without it.
function signLegacy(api, est) {
  const fields = api.signedPriceSnapshot(est);
  delete fields.repairWarranty;
  const noKey = Object.assign({}, est); delete noKey.repairWarranty;
  return Object.assign({}, est, { signedPrice: { fields, fingerprint: api.pricedFingerprint(noKey), totalCents: 50000 } });
}
const REPAIR = {
  id: 'E1', leadId: 'L1', builder: 'template', sourceTemplates: ['jt_rr_shingle_patch'], tierApplies: false,
  warrantyKind: 'repair', warrantyParts: [{ name: 'Shingle repair', kind: 'repair' }], grandTotal: 500,
};

// ══════════════════════════════════════════════════════════════════
section('1. LOCK — repairWarranty is a signed term');
// ══════════════════════════════════════════════════════════════════
[['docs', ROWS], ['functions', ROWS_FN]].forEach(([where, api]) => {
  ok(where + ': repairWarranty is in PRICED_FIELDS', api.PRICED_FIELDS.indexOf('repairWarranty') !== -1);
  const ticked = Object.assign({}, REPAIR, { repairWarranty: true });
  ok(where + ': the snapshot records the box (ticked → true)', api.signedPriceSnapshot(ticked).repairWarranty === true);
  ok(where + ': …and an unticked or missing box as false',
    api.signedPriceSnapshot(Object.assign({}, REPAIR, { repairWarranty: false })).repairWarranty === false
    && api.signedPriceSnapshot(REPAIR).repairWarranty === false);

  const signed = sign(api, ticked);
  ok(where + ': signed with the box ticked, unchanged → no unsigned change', !api.hasUnsignedChanges(signed));
  const unticked = Object.assign({}, signed, { repairWarranty: false });
  ok(where + ': box UNticked after signing → an unsigned change', api.hasUnsignedChanges(unticked));
  ok(where + ': …signedView puts the signed (ticked) box back', api.signedView(unticked).repairWarranty === true);
  const w = api.estimateWarranty(api.signedView(unticked));
  ok(where + ': …so the certificate still prints the signed 1-year warranty', w && w.years === 1 && /1-year workmanship warranty/.test(w.text), JSON.stringify(w));

  const signedOff = sign(api, Object.assign({}, REPAIR, { repairWarranty: false }));
  const tickedLater = Object.assign({}, signedOff, { repairWarranty: true });
  ok(where + ': signed unticked, box ticked after signing → an unsigned change', api.hasUnsignedChanges(tickedLater));
  ok(where + ': …signedView prints no warranty (none was signed)', api.estimateWarranty(api.signedView(tickedLater)).text === '');

  // Old fingerprints do not move: an unticked box is the same version as no box.
  const noKey = Object.assign({}, REPAIR);
  ok(where + ': unticked box = same fingerprint as no box (deal links / stamps keep their version)',
    api.pricedFingerprint(Object.assign({}, REPAIR, { repairWarranty: false })) === api.pricedFingerprint(noKey));
  ok(where + ': a ticked box changes the version', api.pricedFingerprint(ticked) !== api.pricedFingerprint(noKey));

  // Old signed estimates: a stamp without the key reads as it always did.
  const legacy = signLegacy(api, ticked);
  ok(where + ': OLD stamp (before the lock) with a ticked box → no unsigned change', !api.hasUnsignedChanges(legacy));
  ok(where + ': …signedView keeps the saved box (the old copy never carried it)', api.signedView(legacy).repairWarranty === true);
  const legacyRepriced = Object.assign({}, legacy, { grandTotal: 900 });
  ok(where + ': …but a price change on an old stamp is still an unsigned change', api.hasUnsignedChanges(legacyRepriced));

  // The siding package lock (#2463) still holds alongside it.
  const sid = sign(api, { id: 'S1', builder: 'template', sourceTemplates: ['jt_ex_siding_replace_elevation'], tierApplies: false,
    warrantyKind: 'siding', warrantyPackage: 'standard', grandTotal: 9000 });
  ok(where + ': siding package changed after signing → unsigned, signed package wins',
    api.hasUnsignedChanges(Object.assign({}, sid, { warrantyPackage: 'elite' }))
    && api.signedView(Object.assign({}, sid, { warrantyPackage: 'elite' })).warrantyPackage === 'standard');
});
ok('the functions/ copy is byte-identical to the browser copy',
  read('docs/pro/js/customer-estimate-rows.js') === read('functions/customer-estimate-rows.js'));

// ══════════════════════════════════════════════════════════════════
section('2. WIZARD — warranty-cert.js follows the estimate');
// ══════════════════════════════════════════════════════════════════
function wizard(estimates) {
  const byId = {};
  const el = (id) => ({
    id, value: '', textContent: '', disabled: false, options: [],
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
  });
  ['warrantyCertModal', 'wcOwner', 'wcAddr', 'wcDate', 'wcTier', 'wcWork', 'wcTierDesc', 'wcEyebrow'].forEach((id) => { byId[id] = el(id); });
  byId.wcTier.options = ['economy', 'standard', 'preferred', 'elite', 'beyond'].map((v) => ({ value: v, textContent: v }));
  byId.wcTier.value = 'standard';
  const document = { getElementById: (id) => byId[id] || null };
  const toasts = [];
  const calls = [];
  const win = { document, _estimates: estimates || [] };
  win.window = win;
  // Server render: capture the payload the certificate is rendered from.
  win._functions = {};
  win._httpsCallable = () => async (req) => { calls.push(req); return { data: { ok: true, url: 'https://x.test/c.pdf' } }; };
  win.NBDDocViewer = { open() {} };
  const sandbox = {
    window: win, document, console: { log() {}, warn() {}, error() {} }, Date, Math, JSON, Promise, setTimeout,
    showToast: (m, t) => toasts.push([m, t]),
  };
  vm.createContext(sandbox);
  ['docs/pro/js/estimate-config.js', 'docs/pro/js/customer-estimate-rows.js', 'docs/pro/js/warranty-cert.js'].forEach((f) =>
    vm.runInContext(read(f), sandbox, { filename: path.basename(f) }));
  return {
    byId, toasts, calls,
    open: (lead) => vm.runInContext('openWarrantyCertWizard(__lead)', Object.assign(sandbox, { __lead: lead })),
    generate: () => vm.runInContext('generateWarrantyCertPDF()', sandbox),
  };
}
const SIDING = (pkg, extra) => Object.assign({ id: 'ES', leadId: 'L1', builder: 'template', sourceTemplates: ['jt_ex_siding_replace_elevation'],
  tierApplies: false, warrantyKind: 'siding', warrantyParts: [{ name: 'Siding Replacement', kind: 'siding' }], warrantyPackage: pkg, grandTotal: 12000 }, extra || {});

(async () => {
  {
    const w = wizard([sign(ROWS, SIDING('elite'))]);
    w.open({ id: 'L1', firstName: 'Jane', address: '1 A St', tier: 'good' });
    ok('siding Elite estimate: the tier is Elite (not the lead\'s stray tier)', w.byId.wcTier.value === 'elite', w.byId.wcTier.value);
    ok('…the pick is locked (select disabled)', w.byId.wcTier.disabled === true);
    ok('…Work Performed says siding', w.byId.wcWork.value === 'Siding replacement', w.byId.wcWork.value);
    ok('…the terms include the annual courtesy inspection', /Annual courtesy inspection included/.test(w.byId.wcTierDesc.textContent));
    ok('…and say where the terms come from', /From the estimate/.test(w.byId.wcTierDesc.textContent));
    w.byId.wcTier.value = 'standard'; // the rep (or a stale DOM) changes the select anyway
    await w.generate();
    const p = w.calls[0] && w.calls[0].payload;
    ok('…the certificate prints Elite even if the select was changed', p && p.tier === 'elite' && p.isElite === true, p && p.tier);
    ok('…its disclaimer is for siding, not shingles', p && p.notRoof === true && p.productWord === 'siding');
    ok('…and its terms keep the annual inspection', p && /Annual courtesy inspection/.test(p.tierTerms));
  }
  {
    // Signed at Standard, package changed to Elite after signing: the signed one.
    const signed = sign(ROWS, SIDING('standard'));
    const w = wizard([Object.assign({}, signed, { warrantyPackage: 'elite' })]);
    w.open({ id: 'L1' });
    ok('siding package changed after signing: the wizard certifies the SIGNED package (Standard)', w.byId.wcTier.value === 'standard', w.byId.wcTier.value);
  }
  {
    const w = wizard([{ id: 'ER', leadId: 'L1', tier: 'best', grandTotal: 20000 }]);
    w.open({ id: 'L1', tier: 'good', damageType: 'Hail damage' });
    ok('roof estimate at Best: the tier is Elite, locked', w.byId.wcTier.value === 'elite' && w.byId.wcTier.disabled === true, w.byId.wcTier.value);
    ok('…Work Performed keeps the roof wording', w.byId.wcWork.value === 'Hail damage');
    await w.generate();
    const p = w.calls[0] && w.calls[0].payload;
    ok('…a roof certificate keeps the shingle disclaimer (notRoof false)', p && p.notRoof === false && p.isElite === true);
  }
  {
    const w = wizard([{ id: 'EG', leadId: 'L1', name: 'Seamless K5 Gutter System (Full Wrap)', builder: 'template',
      sourceTemplates: ['jt_gi_k5_seamless_full'], tierApplies: false, warrantyKind: 'gutter_system',
      warrantyParts: [{ name: 'Seamless K5 Gutter System (Full Wrap)', kind: 'gutter_system' }], grandTotal: 3000 }]);
    w.open({ id: 'L1', tier: 'best' });
    ok('gutter estimate: no roof tier — the job type\'s 5 years, locked', /5-year workmanship warranty/.test(w.byId.wcTierDesc.textContent)
      && w.byId.wcTier.disabled === true, w.byId.wcTierDesc.textContent);
    await w.generate();
    const p = w.calls[0] && w.calls[0].payload;
    ok('…the certificate prints 5 years, no Elite perks, no shingle disclaimer', p && p.tier === 'workmanship' && p.laborYears === 5
      && !p.isElite && !p.isPreferred && p.notRoof === true && /5-Year Labor Warranty/.test(p.tierLabel), p && JSON.stringify([p.tier, p.laborYears, p.tierLabel]));
    ok('…the work is the estimate\'s name', p && /Gutter System/.test(p.work), p && p.work);
  }
  {
    const w = wizard([Object.assign({}, REPAIR, { repairWarranty: false })]);
    w.open({ id: 'L1' });
    ok('repair estimate without the box: no certificate (nothing to certify)', !w.byId.warrantyCertModal.classList.contains('open')
      && w.toasts.some(([m]) => /no workmanship warranty/.test(m)));
  }
  {
    const w = wizard([]);
    w.open({ id: 'L9', tier: 'better' });
    ok('no estimate: manual pick stays (select enabled, pre-filled from the lead)', w.byId.wcTier.disabled === false && w.byId.wcTier.value === 'preferred', w.byId.wcTier.value);
    w.byId.wcTier.value = 'elite';
    await w.generate();
    const p = w.calls[0] && w.calls[0].payload;
    ok('…and the rep\'s pick is what prints', p && p.tier === 'elite');
  }
  {
    // A lead with an estimate after one without: the lock does not carry over.
    const w = wizard([sign(ROWS, SIDING('preferred'))]);
    w.open({ id: 'L1' });
    w.open({ id: 'L2', tier: 'good' });
    ok('opening a lead without an estimate after one with: unlocked again', w.byId.wcTier.disabled === false && w.byId.wcTier.value === 'standard');
  }

  // ══════════════════════════════════════════════════════════════════
  section('3. PRODUCT — the server certificate names shingles only on a roof');
  // ══════════════════════════════════════════════════════════════════
  {
    const hbs = read('functions/print/templates/warranty.hbs');
    const i = hbs.indexOf('{{#if notRoof}}');
    ok('warranty.hbs has a notRoof branch for the manufacturer disclaimer', i !== -1);
    ok('…that comes before (and so replaces) the shingle wording', i !== -1 && i < hbs.indexOf("The shingle manufacturer's standard limited warranty is a separate"));
    ok('…and names the product, not shingles', /\{\{#if notRoof\}\}Any manufacturer warranty on the \{\{productWord\}\}/.test(hbs));
  }

  // ══════════════════════════════════════════════════════════════════
  section('4. CUSTOMER — customer.html\'s certificate reads the signed copy');
  // ══════════════════════════════════════════════════════════════════
  {
    const src = read('docs/pro/js/customer-bootstrap.module.js');
    const body = src.slice(src.indexOf('window.generateCertFromEstimate = async function'));
    const iSigned = body.indexOf('hasUnsignedChanges(_savedEst)');
    const iWarranty = body.indexOf('estimateWarranty');
    ok('generateCertFromEstimate puts the signed copy back before reading the warranty',
      iSigned !== -1 && iWarranty !== -1 && iSigned < iWarranty && /signedView\(_savedEst\)/.test(body.slice(0, iWarranty)));
  }

  // ══════════════════════════════════════════════════════════════════
  section('5. AGENTS — WORKMANSHIP_YEARS');
  // ══════════════════════════════════════════════════════════════════
  {
    const L = require(path.join(ROOT, 'functions/agent-mcp-logic.js'));
    const Y = L.WORKMANSHIP_YEARS;
    ok('siding by package 5 / 10 / 20', Y.siding && Y.siding.standard === 5 && Y.siding.preferred === 10 && Y.siding.elite === 20);
    ok('gutters 5, guards 2, repairs 1', Y.gutter_system === 5 && Y.guard_only === 2 && Y.repair === 1);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
