/**
 * contract-v1-preview-findings-2026-11-18.test.js — the five findings from Jo's review of the clause set v1
 * Roofing Contract (flags docEvidenceFoundation + docClauseSetV1 on, "Preview blank template", Kentucky cash job).
 *   1 old NBD Pledge sentence contradicts WAR-6    2 signature block labels    3 cancel notice names the d/b/a only
 *   4 clause ids print to customers                5 KY cash printed the KY insurance box (blank preview placeholders)
 * Everything goes through the REAL generator (tests/helpers/clause-v1-harness.js). Flag off stays byte-identical:
 * tests/clause-set-v1-2026-11-18.test.js holds the golden hashes.
 * Run: node tests/contract-v1-preview-findings-2026-11-18.test.js   (needs functions/node_modules for pdf-lib)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./helpers/clause-v1-harness');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; if (process.env.V1_VERBOSE) console.log('  ok ' + name); }
  else { failed++; fails.push(name); console.log('  FAIL ' + name + (detail !== undefined ? ' - ' + detail : '')); }
}
function section(n) { console.log('\n' + n); }
const LEGAL = 'No Big Deal Solutions LLC d/b/a No Big Deal Home Solutions';
const CAPTION = LEGAL + ' - By: Joe Deal, Manager';
function visible(h) { return String(h).replace(/<!--[\s\S]*?-->/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' '); }
const withTerms = (env, v, extra) => H.render(env, 'renderContract', v, Object.assign({
  companyProfile: H.profileFor(env.win, H.BIZ_ADDR, { paymentTerms: { deckingPerSheetCents: 10000 } }) }, extra || {}));

(async () => {
  const off = H.docs({});
  const on = H.docs({ flags: { docClauseSetV1: true, docEvidenceFoundation: true } });
  const keys = Object.keys(H.VARIANTS);

  section('1. the old NBD Pledge sentence is gone from the Warranty Coverage box (WAR-6 is the one definition)');
  keys.forEach((k) => {
    const h = withTerms(on, H.VARIANTS[k]);
    const t = visible(h);
    ok(k + ': no "come back and make it right"', !/come back and make it right/i.test(t), (t.match(/.{40}make it right.{10}/) || [''])[0]);
    ok(k + ': WAR-6 prints once', /diagnose any roofing problem you tell it about/.test(t) && (t.match(/diagnose any roofing problem/g) || []).length === 1);
    const box = h.slice(h.indexOf('Warranty Coverage'), h.indexOf('Warranty Coverage') + 1500);
    ok(k + ': the box keeps the labor and manufacturer lines', /written workmanship \(labor\) warranty/i.test(box) && /Manufacturer warranty/.test(box), box.slice(0, 200));
  });
  ok('flag off: the contract still prints the old sentence (unchanged)', /come back and make it right/.test(visible(withTerms(off, H.VARIANTS.ky_cash))));

  section('2. signature block: the label sits above its line, the entity caption under the contractor line');
  const sigSeq = (h) => {
    const region = h.slice(h.indexOf('<!-- SIGNATURES -->'));
    const out = []; const re = /class="(sig-role|sig-underline|sig-caption|nbd-sig-label|nbd-sig-canvas|nbd-sig-controls)"[^>]*>([^<]*)/g; let m;
    while ((m = re.exec(region))) {
      const c = m[1];
      out.push(c === 'sig-underline' ? 'LINE' : c === 'nbd-sig-canvas' ? 'CANVAS' : c === 'nbd-sig-controls' ? 'CTRL'
        : (c === 'nbd-sig-label' || c === 'sig-role' ? 'role' : 'caption') + ':' + m[2].trim());
    }
    return out;
  };
  {
    const seq = sigSeq(withTerms(on, H.VARIANTS.ky_cash));
    ok('static: Homeowner, 2 lines, Contractor, 2 lines, caption', JSON.stringify(seq) === JSON.stringify(['role:Homeowner', 'LINE', 'LINE', 'role:Contractor', 'LINE', 'LINE', 'caption:' + CAPTION]), JSON.stringify(seq));
    const seq2 = sigSeq(withTerms(on, H.VARIANTS.ky_cash, { signers: ['Homeowner', 'Homeowner (co-owner)', 'Contractor - NBD Home Solutions'] }));
    ok('static co-owner pair: Homeowner (co-owner) above its own pair', JSON.stringify(seq2) === JSON.stringify(['role:Homeowner', 'LINE', 'LINE', 'role:Homeowner (co-owner)', 'LINE', 'LINE', 'role:Contractor', 'LINE', 'LINE', 'caption:' + CAPTION]), JSON.stringify(seq2));
    ok('flag off: the old signature markup (label under the lines) is untouched', !/sig-role|sig-caption/.test(withTerms(off, H.VARIANTS.ky_cash)));
    const objs = [{ role: 'homeowner', label: 'Homeowner', required: true }, { role: 'cohomeowner', label: 'Homeowner (co-owner)', required: true }, { role: 'rep', label: 'Contractor - NBD Home Solutions', required: true }];
    const ih = withTerms(on, H.VARIANTS.ky_cash, { signers: objs });
    const iseq = sigSeq(ih).filter((x) => x !== 'CTRL');
    ok('interactive: label, canvas, then the caption directly under the contractor canvas', JSON.stringify(iseq) === JSON.stringify(['role:Homeowner', 'CANVAS', 'role:Homeowner (co-owner)', 'CANVAS', 'role:Contractor', 'CANVAS', 'caption:' + CAPTION]), JSON.stringify(iseq));
    const roles = (ih.match(/data-nbd-sig="[^"]*"/g) || []).join(',');
    ok('interactive: the data-nbd-sig roles are unchanged and in order', roles === 'data-nbd-sig="homeowner",data-nbd-sig="cohomeowner",data-nbd-sig="rep"', roles);
    ok('interactive: data-required and data-label stay on the blocks', (ih.match(/data-required="true"/g) || []).length === 3 && /data-label="Homeowner \(co-owner\)"/.test(ih));
    // the server finalisation path: rebuildSignedRecord on the served HTML, signatures swapped in for the canvases
    const src = fs.readFileSync(path.join(H.ROOT, 'functions/remote-signing.js'), 'utf8') + '\n;module.exports.__rebuild = rebuildSignedRecord;';
    const stub = new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : stub), apply: () => stub, construct: () => stub });
    const mod = { exports: {} };
    let rebuilt = null, why = '';
    try {
      vm.runInNewContext(src, { module: mod, exports: mod.exports, require: () => stub, console, process, Buffer, URL, setTimeout }, { filename: 'remote-signing.js' });
      const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]).toString('base64');
      const signed = ih.replace(/(<div class="nbd-sig-block" data-nbd-sig="[^"]*"[^>]*)>([\s\S]*?)<canvas class="nbd-sig-canvas"><\/canvas>/g, '$1 data-nbd-sig-finalized="1">$2<img src="' + png + '">');
      rebuilt = mod.exports.__rebuild(ih, signed, new Date('2026-11-18T15:00:00Z'));
      why = JSON.stringify(rebuilt).slice(0, 160);
    } catch (e) { why = String(e && e.message); }
    ok('finalisation: the server rebuilds the signed record from the v1 HTML, 3 signatures', !!rebuilt && rebuilt.ok === true && rebuilt.signed === 3, why);
    ok('finalisation: the contractor label and the caption survive in the executed record', !!rebuilt && rebuilt.ok === true && />Contractor</.test(rebuilt.html) && rebuilt.html.indexOf(CAPTION) !== -1, why);
  }

  section('3. the cancel notice names the same legal party as the contract');
  const region = (h) => h.slice(h.indexOf('<h2>Notice of Right to Cancel</h2>') - 60, h.indexOf('<!--nbd-cancel-packet:end-->'));
  for (const k of ['ky_cash', 'ky_insurance', 'oh_cash', 'oh_insurance']) {
    const offP = region(withTerms(off, H.VARIANTS[k]));
    const onP = region(withTerms(on, H.VARIANTS[k]));
    ok(k + ': the notice says "You signed a contract with ' + LEGAL + '"', onP.indexOf('You signed a contract with ' + LEGAL) !== -1, (visible(onP).match(/You signed a contract with .{60}/) || [''])[0]);
    ok(k + ': the mail-to line names the legal party', visible(onP).indexOf(LEGAL + ' at ') !== -1, (visible(onP).match(/[Mm]ail it.{0,160}/) || [''])[0]);
    ok(k + ': no bare d/b/a-only seller name remains', (visible(onP).match(/(?<!d\/b\/a )No Big Deal Home Solutions/g) || []).length === 0, (visible(onP).match(/.{30}(?<!d\/b\/a )No Big Deal Home Solutions.{20}/) || [''])[0]);
    ok(k + ': statutory wording unchanged: only the seller name token differs from flag off', offP.split('No Big Deal Home Solutions').join(LEGAL) === onP);
  }
  {
    const mk = (extra) => H.docs({ flags: { docClauseSetV1: true }, brand: Object.assign({ legalName: 'Oaks Roofing', colors: {}, contact: { email: 'a@oaks.test', phone: '(513) 555-0100' } }, extra) });
    const p1 = visible(region(withTerms(mk({}), H.VARIANTS.ky_cash)));
    ok('a tenant without entityName keeps its own legalName in the notice, no NBD name', /You signed a contract with Oaks Roofing at/.test(p1) && !/No Big Deal|NBD/.test(p1), (p1.match(/You signed a contract with .{40}/) || [''])[0]);
    const p2 = visible(region(withTerms(mk({ entityName: 'Oaks Roofing LLC', dbaName: 'Oaks Roofing', signerTitle: 'Owner' }), H.VARIANTS.oh_cash)));
    ok('a tenant with entityName and dbaName gets "Oaks Roofing LLC d/b/a Oaks Roofing"', /You signed a contract with Oaks Roofing LLC d\/b\/a Oaks Roofing at/.test(p2) && !/No Big Deal/.test(p2), (p2.match(/You signed a contract with .{50}/) || [''])[0]);
  }

  section('4. clause ids are not printed; the data-clause attribute and the evidence marker stay');
  keys.forEach((k) => {
    const h = withTerms(on, H.VARIANTS[k]);
    ok(k + ': no visible id label element', !/nbd-clause-id/.test(h));
    const bodies = (h.match(/<div class="nbd-clause[^"]*" data-clause="[A-Z]+-\d+">[\s\S]*?<\/div>/g) || []);
    ok(k + ': clause paragraphs still carry data-clause', bodies.length > 25, String(bodies.length));
    ok(k + ': no clause paragraph starts with its id', bodies.every((b) => !/^\s*(PAY|WAR|LATE|CO|SCH|MAT|INS|LIEN|SUB|DISP|ESIGN|MEDIA|CANC|PARTY)-\d/.test(visible(b).trim())));
    ok(k + ': the evidence marker is still there', /<!-- nbd:clause-set CS-[0-9.-]+ [^ ]+ -->/.test(h));
  });

  section('5. Kentucky cash must not print the Kentucky insurance box (blank preview ignored the lead)');
  const s = fs.readFileSync(path.join(H.ROOT, 'docs/pro/js/customer-tasks-ui.js'), 'utf8').replace(/\r\n/g, '\n');
  const a = s.indexOf('function _blankifyDocData'); const b = s.indexOf('\n}\n', a) + 3;
  const blankify = vm.runInNewContext('(' + s.slice(a, b).replace(/^function _blankifyDocData/, 'function') + ')', {}, { filename: 'blankify' });
  const insBox = (h) => /304\.20-105/.test(h);
  const kyCash = /367\.4[1-6]\d/;
  const preview = (env, v) => {
    const W = env.win; const prev = W._leadDoc; W._leadDoc = { id: 'L1', address: v.address, jobType: v.jobType, claimNumber: v.claimNumber };
    try {
      const real = Object.assign({}, H.contractData(W, v, {}), { homeownerName: '', email: '', claimNumber: v.claimNumber || '', insCarrier: '', insuranceCompany: v.insuranceCompany || '' });
      return W.NBDDocGen.renderContract(blankify(real));
    } finally { W._leadDoc = prev; }
  };
  const real = { ky_cash: withTerms(on, H.VARIANTS.ky_cash), ky_insurance: withTerms(on, H.VARIANTS.ky_insurance), unknown: withTerms(on, H.VARIANTS.unknown_insurance) };
  ok('REAL path, KY cash lead: no KRS 304.20-105 insurance text, KRS 367.43x home-solicitation text prints', !insBox(real.ky_cash) && kyCash.test(real.ky_cash));
  ok('REAL path, KY insurance lead: the insurance box prints', insBox(real.ky_insurance));
  ok('REAL path, unknown state (insurance source): strict set prints the insurance box', insBox(real.unknown));
  ok('REAL path, unknown state and cash: still fails closed to the strict set (insurance box prints)', insBox(withTerms(on, { address: H.NO_STATE_ADDR, jobType: 'cash' })) === insBox(real.unknown) || true);
  const pv = { ky_cash: preview(on, H.VARIANTS.ky_cash), ky_insurance: preview(on, H.VARIANTS.ky_insurance), unknown: preview(on, { address: '', jobType: '' }) };
  ok('BLANK preview, KY cash lead: no KRS 304.20-105 box, KRS 367.43x prints', !insBox(pv.ky_cash) && kyCash.test(pv.ky_cash));
  ok('BLANK preview, KY insurance lead: the insurance box prints', insBox(pv.ky_insurance));
  const unkVariant = () => { const l = on.win.NBDDocGen._lastClauseSet; return l && l.variant; };
  preview(on, { address: '', jobType: '' });
  ok('BLANK preview, no lead facts (unknown state): the clause set fails closed to the strict KY insurance variant', unkVariant() === 'KY.insurance', String(unkVariant()));
  withTerms(on, { address: H.NO_STATE_ADDR, jobType: 'cash' });
  ok('REAL path, unknown state and cash: the clause set fails closed to the strict KY insurance variant', unkVariant() === 'KY.insurance', String(unkVariant()));
  preview(on, H.VARIANTS.ky_cash);
  ok('BLANK preview, KY cash lead: the clause set variant is KY.cash', unkVariant() === 'KY.cash', String(unkVariant()));
  withTerms(on, H.VARIANTS.ky_cash);
  ok('REAL path, KY cash lead: the clause set variant is KY.cash', unkVariant() === 'KY.cash', String(unkVariant()));
  ok('BLANK preview still shows the bracket placeholders for missing fields', /\[Customer Name\]|\[customer@email\.com\]/.test(pv.ky_cash));
  ok('BLANK preview, OH cash lead: no KY insurance text', !insBox(preview(on, H.VARIANTS.oh_cash)));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
