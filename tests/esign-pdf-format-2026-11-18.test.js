#!/usr/bin/env node
/**
 * tests/esign-pdf-format-2026-11-18.test.js: the e-sign contract PDF's print
 * layout (three-size format pass, 2026-11-18). Every page carries a running
 * footer with "Page n of N", a line item that starts a continuation page gets
 * the Description / Qty / Amount headings again, brand colours print only when
 * the caller passes them (a tenant is never printed in NBD's), and none of it
 * moves a signature or date field off its page.
 */
'use strict';
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
const E = require(path.join(ROOT, 'functions/estimate-esign-pdf.js'));

let passed = 0, failed = 0;
function ok(l, c, d) { if (c) { console.log('  ✓ ' + l); passed++; } else { console.log('  ✗ ' + l + (d ? ' — ' + String(d).slice(0, 200) : '')); failed++; } }

function pdfText(bytes) {
  const s = Buffer.from(bytes);
  const L = s.toString('latin1');
  let out = '';
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(L))) {
    const st = m.index + m[0].length;
    const en = L.indexOf('endstream', st);
    try { out += zlib.inflateSync(s.subarray(st, en)).toString('latin1'); } catch (_) { /* not a flate stream */ }
  }
  return out.replace(/<([0-9A-Fa-f]+)>/g, (a, h) => Buffer.from(h, 'hex').toString('latin1'));
}
const input = (n, extra) => Object.assign({
  companyName: 'Acme Roofing', sellerAddress: 'PO Box 1, Goshen, OH 45122', title: 'Roof replacement', estimateNumber: 'EST-9',
  preparedDate: 'November 18, 2026', customer: { name: 'Pat Homeowner', address: '1 Main St' },
  lines: Array.from({ length: n }, (_, i) => ({ name: 'Line item ' + (i + 1) + ' with a long description of the work on the roof deck', quantity: i + 1, lineTotalCents: 12345 * (i + 1) })),
  totalCents: 1500000, depositPlan: null, signers: [{ id: 's1', name: 'Pat Homeowner' }],
}, extra || {});
const NAVY = /0\.10\d* 0\.18\d* 0\.34\d* rg/;

(async () => {
  console.log('A. footer and page numbers');
  const short = await E.buildEstimateContractPdf(input(3));
  const long = await E.buildEstimateContractPdf(input(40));
  for (const [name, r] of [['3 lines', short], ['40 lines', long]]) {
    const t = pdfText(r.bytes);
    const N = r.pages.length;
    let all = true;
    for (let p = 1; p <= N; p++) if (!t.includes('Page ' + p + ' of ' + N)) all = false;
    ok(name + ': every page has "Page n of ' + N + '"', all);
    ok(name + ': footer names the company and estimate', t.includes('Acme Roofing') && t.includes('Estimate #EST-9'));
  }
  ok('40 lines spill onto a second page of the table', long.pages.length > short.pages.length);

  console.log('B. table headings repeat');
  const hdrs = (pdfText(long.bytes).match(/\(Description\)|Description/g) || []).length;
  ok('"Description" heading printed more than once on a long table', hdrs >= 2, hdrs);
  ok('a short table prints its heading once', (pdfText(short.bytes).match(/Description/g) || []).length === 1);

  console.log('C. brand colours only when passed');
  const plain = pdfText((await E.buildEstimateContractPdf(input(3))).bytes);
  const branded = pdfText((await E.buildEstimateContractPdf(input(3, { brand: { primary: '#1A3057', accent: '#BD5728' } }))).bytes);
  const bad = pdfText((await E.buildEstimateContractPdf(input(3, { brand: { primary: 'navy', accent: '12' } }))).bytes);
  ok('no brand: no navy anywhere', !NAVY.test(plain));
  ok('brand passed: navy prints', NAVY.test(branded));
  ok('an invalid brand is ignored', !NAVY.test(bad));

  console.log('D. signature fields stay on real pages');
  const f = long.fields;
  ok('signature and date fields still exist', f.some((x) => x.type === 'signature') && f.some((x) => x.type === 'date'));
  ok('every field is on a page that exists, above the footer', f.every((x) => x.page >= 0 && x.page < long.pages.length && x.y >= 40), JSON.stringify(f.map((x) => [x.page, x.y])));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('ERR', e.stack); process.exit(1); });
