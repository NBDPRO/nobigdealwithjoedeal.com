#!/usr/bin/env node
/**
 * tests/doc-phone-layout-letterhead-2026-11-18.test.js: the phone layout also
 * covers the .doc-page / .letterhead documents (invoice, receipt, supplement
 * request, financing options, company intro). Three-size format pass,
 * 2026-11-18: at 390px their header collided with the contact lines, the
 * line-item table ran off the screen and the two-up grids were squeezed.
 * Real-browser check at 360/390/412 was done by hand; this pins the contract
 * the surfaces rely on: the sheet is added to the copy a surface SHOWS, and
 * stripPhoneLayout gives back the exact stored document.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const baseSrc = rd('docs/pro/js/doc-phone-layout.js');
const extSrc = rd('docs/pro/js/doc-phone-layout-letterhead.js');

let passed = 0, failed = 0;
function ok(l, c, d) { if (c) { console.log('  ✓ ' + l); passed++; } else { console.log('  ✗ ' + l + (d ? ' — ' + String(d).slice(0, 200) : '')); failed++; } }

const win = {};
const ctx = vm.createContext({ window: win });
vm.runInContext(baseSrc, ctx);
vm.runInContext(extSrc, ctx);
const L = win.NBDDocPhoneLayout;
ok('exposes the layout API', L && typeof L.withPhoneLayout === 'function' && typeof L.stripPhoneLayout === 'function');

const head = '<!doctype html><html lang="en"><head><meta charset="utf-8"><style>.x{}</style></head><body>';
const invoice = head + '<div class="doc-page"><div class="letterhead"></div><table class="items"></table></div></body></html>';
const letter = head + '<div class="document-container"><div class="document-header"></div></div></body></html>';
const other = head + '<div class="plain">hello</div></body></html>';

console.log('A. letterhead family');
const inv = L.withPhoneLayout(invoice);
ok('an invoice-family document gets the sheet', inv !== invoice && inv.includes('id="' + L.DOC_PAGE_STYLE_ID + '"'));
ok('the sheet is the last thing in <head>', inv.indexOf(L.DOC_PAGE_STYLE_ID) < inv.indexOf('</head>') && /<\/style><\/head>/.test(inv));
ok('exactly one sheet', inv.split('id="' + L.DOC_PAGE_STYLE_ID + '"').length === 2);
ok('sheet is screen-only and phone-width only', /@media screen and \(max-width:600px\)\{[^]*\.letterhead\{/.test(inv));
ok('it stacks the letterhead, the two-up grids and the plan grid', /\.letterhead\{[^}]*flex-direction:column/.test(inv) && /grid-template-columns"\]\{grid-template-columns:1fr/.test(inv) && /\.plan-grid\{grid-template-columns:1fr/.test(inv));
ok('the line-item table scrolls inside itself, never past the page', /\.items\{display:block;max-width:100%;overflow-x:auto/.test(inv));
ok('stripPhoneLayout returns the stored document byte for byte', L.stripPhoneLayout(inv) === invoice);

console.log('B. nothing else changes');
const lt = L.withPhoneLayout(letter);
ok('a letter document still gets its own sheet, not the letterhead one', lt.includes('id="' + L.STYLE_ID + '"') && !lt.includes(L.DOC_PAGE_STYLE_ID));
ok('and strips back exactly', L.stripPhoneLayout(lt) === letter);
ok('any other document is shown exactly as served', L.withPhoneLayout(other) === other);
const noHead = '<div class="doc-page"></div>';
ok('a document with no </head> is shown exactly as served (no quirks-mode style)', L.withPhoneLayout(noHead) === noHead);
ok('non-string input passes through', L.withPhoneLayout(null) === null && L.withPhoneLayout(undefined) === undefined);

console.log('C. where it loads');
const tag = 'js/doc-phone-layout-letterhead.js';
for (const p of ['portal', 'sign']) {
  const h = rd('docs/pro/' + p + '.html');
  ok(p + '.html loads the extension after the base layout', h.includes(tag) && h.indexOf('js/doc-phone-layout.js') < h.indexOf(tag));
}
for (const p of ['dashboard', 'customer']) ok(p + '.html does not load it (its boot-byte budget is full)', !rd('docs/pro/' + p + '.html').includes(tag));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
