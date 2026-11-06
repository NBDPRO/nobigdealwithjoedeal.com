/**
 * tests/portal-reply-line-2026-11-05.test.js
 *
 * Customer portal follow-up (Jo, 2026-11-05; documentation/projects/CUSTOMER-PORTAL-PLAN-2026-11-04.md):
 * a fixed line, "Joe usually answers the same day.", sits above the message
 * box in the portal's #pm-card, on NBD portals only. A tenant's turnaround is
 * theirs to state, so a tenant portal must not wear Joe's promise.
 *
 * Run: node tests/portal-reply-line-2026-11-05.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

const LINE = 'Joe usually answers the same day.';
const code = stripComments(read('docs/pro/js/portal.js'));
const html = read('docs/pro/portal.html');

// The #pm-card markup block, from its opening div to the Send button.
const cardStart = code.indexOf('<div class="card" id="pm-card">');
const cardEnd = code.indexOf('id="pm-send"', cardStart);
const card = cardStart >= 0 && cardEnd > cardStart ? code.slice(cardStart, cardEnd) : '';

ok('the #pm-card block is found (positive control)', card.length > 0 && card.includes('id="pm-text"'));
ok('the line appears exactly once in portal.js', code.split(LINE).length - 1 === 1);
ok('the line is inside #pm-card', card.includes(LINE));
ok('the line sits above the message box', card.indexOf(LINE) >= 0 && card.indexOf(LINE) < card.indexOf('id="pm-text"'));

// Gated on isNbdCompany, with nothing for a tenant.
const gate = /\(isNbdCompany\s*\?\s*'<p[^']*data-pm-reply-line[^']*>Joe usually answers the same day\.<\/p>'\s*:\s*''\)/;
ok('the line is gated on isNbdCompany, empty for a tenant', gate.test(card));

// isNbdCompany must be the render function's own binding, defined before #pm-card is built.
const defAt = code.lastIndexOf('const isNbdCompany', cardStart);
ok('isNbdCompany is defined before #pm-card is built', defAt > 0 && defAt < cardStart);
const between = code.slice(defAt, cardStart);
ok('no function boundary between the definition and the card (same scope)',
  !/\n {2}function \w+\s*\(/.test(between) && !/\n {2}\}\)\(\);/.test(between));

ok('the line is styled by a .pm-reply-line class, not an inline style', /\.pm-reply-line\s*\{[^}]*color:\s*var\(--muted\)/.test(html) && !/data-pm-reply-line[^>]*style=/.test(card));
ok('portal.html cache-busts portal.js past v=25', (() => {
  const m = html.match(/js\/portal\.js\?v=(\d+)/);
  return !!m && Number(m[1]) >= 26;
})());

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
