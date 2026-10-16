/**
 * tests/pdf-libs-2026-10-16.test.js — the vendored client PDF libraries
 * (repos report 2026-10-16 item 2).
 *
 * jsPDF 2.5.1 matched 12 GitHub advisories (2 critical); html2pdf < 0.14.0 is
 * CVE-2026-22787, and both html2pdf 0.14.0 dist files still bundle jsPDF
 * 4.0.0. scripts/vendor-pdf-libs.js vendors jsPDF 4.2.1 as published and
 * builds html2pdf 0.14.0 from src/ on top of window.jspdf, so the
 * `pdfexport` bundle fetches ONE jsPDF (it used to fetch two).
 *
 * The browser half is tests/pdf-export-walk-2026-10-16.test.js.
 * Run: node tests/pdf-libs-2026-10-16.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { VERSIONS } = require('../scripts/vendor-pdf-libs.js');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

console.log('\nVERSIONS (first patched releases from the GitHub Advisory Database, 2026-10-16)');
ok('jsPDF >= 4.2.1 (GHSA-wfv2-pwc8-crg5, GHSA-7x6v-j9x4-qf24 and the ten older ones)', cmp(VERSIONS.jspdf, '4.2.1') >= 0, VERSIONS.jspdf);
ok('html2pdf.js >= 0.14.0 (CVE-2026-22787, GHSA-w8x4-x68c-m6fc)', cmp(VERSIONS['html2pdf.js'], '0.14.0') >= 0, VERSIONS['html2pdf.js']);

console.log('\nTHE PDFEXPORT BUNDLE');
const loader = fs.readFileSync(path.join(DOCS, 'pro', 'js', 'script-loader.js'), 'utf8');
const m = loader.match(/pdfexport:\s*\[([\s\S]*?)\]/);
const files = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
ok('pdfexport lists exactly jsPDF then html2pdf, at versioned paths', JSON.stringify(files) === JSON.stringify([
  '/assets/vendor/jspdf/' + VERSIONS.jspdf + '/jspdf.umd.min.js',
  '/assets/vendor/html2pdf/' + VERSIONS['html2pdf.js'] + '/html2pdf.nbd.min.js',
]), JSON.stringify(files));
for (const f of files) ok('exists on disk: ' + f, fs.existsSync(path.join(DOCS, f)));

const jspdf = fs.existsSync(path.join(DOCS, files[0] || 'x')) ? fs.readFileSync(path.join(DOCS, files[0]), 'latin1') : '';
const h2p = fs.existsSync(path.join(DOCS, files[1] || 'x')) ? fs.readFileSync(path.join(DOCS, files[1]), 'utf8') : '';
ok('the jsPDF file is the ' + VERSIONS.jspdf + ' release', new RegExp('Version ' + VERSIONS.jspdf.replace(/\./g, '\\.') + ' Built on').test(jspdf));
ok('the html2pdf build carries NO jsPDF of its own (no PDF writer: "/Type /Catalog")', h2p.length > 50000 && h2p.indexOf('/Type /Catalog') === -1);
ok('…while the jsPDF file does (so that check can fail)', jspdf.indexOf('/Type /Catalog') !== -1);
ok('the html2pdf build reads the page\'s jsPDF and says so up front', /window\.jspdf/.test(h2p) && /html2pdf\.js 0\.14\.0/.test(h2p.slice(0, 600)));
ok('the html2pdf build sets window.html2pdf', /window\.html2pdf=__nbdHtml2pdf\.default;?\s*$/.test(h2p));
ok('no eval / new Function in the html2pdf build (strict script-src)', !/\bnew Function\(|[^\w.$]eval\(/.test(h2p));
ok('LICENSES.txt ships next to the build (MIT x2 + DOMPurify)', (() => {
  const p = path.join(path.dirname(path.join(DOCS, files[1] || 'x')), 'LICENSES.txt');
  return fs.existsSync(p) && /html2pdf\.js/.test(fs.readFileSync(p, 'utf8')) && /html2canvas/.test(fs.readFileSync(p, 'utf8')) && /DOMPurify|dompurify/i.test(fs.readFileSync(p, 'utf8'));
})());

console.log('\nNO OLD COPIES');
ok('the old jsPDF 2.5.1 file is gone', !fs.existsSync(path.join(DOCS, 'assets', 'vendor', 'jspdf', 'jspdf.umd.min.js')));
ok('the old html2pdf bundle (jsPDF 2.3.1 inside) is gone', !fs.existsSync(path.join(DOCS, 'assets', 'vendor', 'html2pdf', 'html2pdf.bundle.min.js')));
function walk(d, out) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!/^(node_modules|vendor)$/.test(e.name)) walk(p, out); } else if (/\.(js|html|mjs)$/.test(e.name)) out.push(p); } return out; }
const refs = walk(DOCS, []).filter((f) => /html2pdf\.bundle|vendor\/jspdf\/jspdf\.umd/.test(fs.readFileSync(f, 'utf8')));
ok('nothing under docs/ references the old paths', refs.length === 0, refs.map((f) => path.relative(ROOT, f)).join(', '));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
