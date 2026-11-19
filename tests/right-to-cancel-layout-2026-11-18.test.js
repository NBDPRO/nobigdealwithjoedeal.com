/**
 * tests/right-to-cancel-layout-2026-11-18.test.js
 *
 * Bug (Jo, 2026-11-18): in the document viewer's "Preview blank template" of
 * the Notice of Right to Cancel, the dark running-footer band (company name,
 * phone, "Notice of Right to Cancel") painted ON TOP of the first lines of the
 * detachable forms page (the "Cut along the dashed line" note and the
 * "Detach along this line" row). Cause: the shared `.footer` band carries
 * `margin-bottom:-40px` (it bleeds to the page edge at the END of a document);
 * renderRightToCancel put it BEFORE the forms, so the negative margin pulled
 * the next block 40px up under the band. On screen the forced page break does
 * nothing, so the overlap was visible and statutory text was hidden.
 *
 * Asserts on markup/CSS (no browser): wherever a `.footer` band is followed by
 * more document content, a flow-root wrapper must contain its negative margin
 * and pad the next block clear of it. Also: the cancel packet inside the
 * Roofing Contract is NOT affected (the footer comes after it).
 *
 * Run: node tests/right-to-cancel-layout-2026-11-18.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const JS = path.join(__dirname, '..', 'docs/pro/js');

function loadEnv() {
  const brand = { legalName: 'No Big Deal Home Solutions', colors: {}, contact: { mailingAddress: '4400 Test Pike, Cincinnati, OH 45202' } };
  const win = { _brand: () => brand, _leadDoc: null };
  win.window = win;
  const noop = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, classList: { add() {}, remove() {} } });
  const sb = {
    window: win,
    document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, createElement: noop, head: noop(), body: noop() },
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON, Intl,
  };
  vm.createContext(sb);
  ['ky-insurance-law.js', 'deposit-rule.js', 'estimate-config.js', 'tenant-rules.js', 'document-generator.js',
    'document-generator-templates.js', 'document-generator-library.js', 'doc-preflight.js']
    .forEach((f) => vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), sb, { filename: f }));
  return win.NBDDocGen;
}
const DG = loadEnv();
const KY = { leadId: 'L1', homeownerName: 'Dana Whitfield', address: '18 Linden Ave, Fort Thomas, KY 41075', jobType: 'insurance', contractDate: '2026-10-02' };
const OH = { leadId: 'L2', homeownerName: 'Marcus Reyes', address: '902 Ridge Rd, Cincinnati, OH 45230', jobType: 'retail', contractDate: '2026-10-02' };

/** The footer band's margin-bottom (negative) must be contained when content follows it. */
function footerOverlap(html) {
  const m = /<div class="footer">/.exec(html);
  if (!m) return { found: false };
  const before = html.slice(0, m.index);
  // The footer holds only spans, so its first </div> closes it.
  const end = html.indexOf('</div>', m.index) + 6;
  const after = html.slice(end).replace(/^\s*<\/div>/, '');
  const wrapped = /<div[^>]*style="[^"]*display:\s*flow-root[^"]*padding-bottom:\s*\d+px[^"]*"[^>]*>\s*$/.test(before);
  const followed = /nbd-noc-page/.test(after);
  return { found: true, wrapped, followed };
}

console.log('\nRight to Cancel: running footer must not overlap the forms page');
[['KY', KY], ['OH', OH]].forEach(([n, d]) => {
  const html = DG.renderRightToCancel(JSON.parse(JSON.stringify(d)));
  const f = footerOverlap(html);
  ok(n + ': footer band present', f.found);
  ok(n + ': forms follow the footer band', f.followed);
  ok(n + ': negative-margin footer is contained by a flow-root wrapper with clearance', f.wrapped,
    'the band has margin-bottom:-40px; unwrapped, it paints over the next 40px (the forms-page note and first detach row)');
  ok(n + ': forms page still starts on a forced page break', /class="nbd-noc-page"[^>]*page-break-before:always/.test(html));
  ok(n + ': no fixed/sticky/absolute positioning on the forms pages', !/nbd-noc-page"[^>]*position:/.test(html));
  ok(n + ': statutory text intact (detach row + form caption)', /Detach along this line/.test(html) && /NOTICE OF CANCELLATION/i.test(html));
});

console.log('\nShared footer CSS (the cause) is unchanged');
const tpl = fs.readFileSync(path.join(JS, 'document-generator-templates.js'), 'utf8');
ok('.footer keeps margin:40px -50px -40px -50px (bleed at document end)', /\.footer \{[\s\S]{0,200}?margin:40px -50px -40px -50px/.test(tpl));

console.log('\nContract cancel packet (not affected)');
const dgSrc = fs.readFileSync(path.join(JS, 'document-generator.js'), 'utf8');
ok('contract: footer rendered AFTER the cancel packet in both contract templates',
  (dgSrc.match(/\$\{stat\.cancelPacket\}\s*<\/div>\s*\$\{this\.affiliateRow[^}]*\}\s*\$\{this\.renderFooter/g) || []).length === 2);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
