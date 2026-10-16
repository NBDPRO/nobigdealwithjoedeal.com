#!/usr/bin/env node
/**
 * tests/guide-pdfs-2026-10-16.test.js — the typeset guide PDFs under
 * /guides/pdf/<slug>.pdf (built by NBD Docs Studio, Typst, from the same
 * Markdown as the pages in site-src/guides/).
 *
 * For every guide registered in scripts/build-guides.js:
 *   - docs/guides/pdf/<slug>.pdf exists, is a whole PDF (header and %%EOF),
 *     is under 3 MB, and declares PDF/UA-1 and PDF/A-2 in its metadata
 *   - its page carries the PDF slot pointing at that file (guide-pdf-slot.js
 *     sets the href only after a same-origin HEAD finds the PDF)
 * And the plumbing: *.pdf is binary in .gitattributes (an EOL conversion
 * corrupts a PDF), and firebase.json gives /guides/pdf/** a short public
 * Cache-Control (a rebuilt PDF replaces the file at the same URL).
 *
 * Rebuild a PDF: node docs-studio/build.js <slug> --pdf (nbd-agents repo),
 * then copy docs-studio/out/<slug>/<slug>.pdf to docs/guides/pdf/.
 *
 * Run: node tests/guide-pdfs-2026-10-16.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const B = require(path.join(ROOT, 'scripts/build-guides.js'));
const MAX_BYTES = 3 * 1024 * 1024;

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 300) : '')); failed++; }
}

console.log('A. one PDF per guide');
ok('build-guides registers the 7 guides', B.GUIDES.length >= 7, B.GUIDES.length);
for (const g of B.GUIDES) {
  const rel = 'docs/guides/pdf/' + g.slug + '.pdf';
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) { ok(rel + ' exists', false); continue; }
  const buf = fs.readFileSync(file);
  const head = buf.subarray(0, 8).toString('latin1');
  const tail = buf.subarray(Math.max(0, buf.length - 32)).toString('latin1');
  const text = buf.toString('latin1');
  ok(rel + ': starts with %PDF- and ends with %%EOF', head.startsWith('%PDF-') && /%%EOF\s*$/.test(tail), JSON.stringify(head) + ' … ' + JSON.stringify(tail));
  ok(rel + ': under 3 MB', buf.length < MAX_BYTES, buf.length + ' bytes');
  ok(rel + ': declares PDF/UA-1 and PDF/A-2 (Docs Studio QA ran veraPDF on it)', /pdfuaid:part>1</.test(text) && /pdfaid:part>2</.test(text));
  const page = fs.readFileSync(path.join(ROOT, g.page), 'utf8');
  ok(g.page + ': PDF slot points at /guides/pdf/' + g.slug + '.pdf', page.includes('data-pdf-slot data-pdf-href="/guides/pdf/' + g.slug + '.pdf"'));
}

console.log('B. plumbing');
const attrs = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8');
ok('.gitattributes marks *.pdf binary', /^\*\.pdf\s+binary\s*$/m.test(attrs));
const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
const hosting = Array.isArray(fb.hosting) ? fb.hosting[0] : fb.hosting;
const rule = (hosting.headers || []).find((h) => h.source === '/guides/pdf/**');
const cc = rule && (rule.headers || []).find((h) => h.key === 'Cache-Control');
const maxAge = cc && /max-age=(\d+)/.exec(cc.value);
ok('firebase.json: /guides/pdf/** has a public Cache-Control of a day or less', !!(cc && /public/.test(cc.value) && maxAge && Number(maxAge[1]) > 0 && Number(maxAge[1]) <= 86400), cc && cc.value);
const ignored = (hosting.ignore || []).some((p) => /pdf/i.test(p));
ok('firebase.json: PDFs are not in the hosting ignore list', !ignored, JSON.stringify(hosting.ignore));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
