/**
 * tests/price-fixture-privacy.test.js
 *
 * The repo is public and the supplier price ledger is about private cost data, so its
 * tests and fixtures must never carry a real price, a real supplier next to a number, or
 * a real SKU (design section 7 of
 * documentation/projects/LIVE-SUPPLIER-PRICING-DESIGN-2026-11-17.md).
 *
 * Scope is an explicit list, never a glob: every file under tests/fixtures/pricing/, the
 * suites named price-logic-, price-ledger-, price-import-, price-change-, price-check-,
 * price-index-, price-fixture-, and firestore-rules.price-ledger.test.js. One check keeps
 * the list honest: every tests/price-*.test.js on disk is in scope, or is exactly the
 * pinned legacy suite price-book-2026-10-02.test.js.
 *
 * Rules in scope:
 *   - every INPUT money literal (a value of priceMicros, priceCents, extCents, listCents)
 *     is a multiple of 1111 once its decimal point is removed. A derived value is computed
 *     in the test, or sits on a line that ends "// derived" (skipped here)
 *   - every SKU literal is empty or starts TEST-
 *   - no real supplier label within 200 characters of a money literal
 *   - no .csv, .xlsx or .pdf under tests/fixtures/pricing/
 * Also: no price-* client file is exempt from the cost-privacy scan, and no ledger file
 * outside price-logic.js converts money.
 *
 * A pure file scan. Run: node tests/price-fixture-privacy.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

const ROOT = path.join(__dirname, '..');
const TESTS = __dirname;
const FIXTURES = path.join(TESTS, 'fixtures', 'pricing');
const PREFIXES = ['price-logic-', 'price-ledger-', 'price-import-', 'price-change-', 'price-check-', 'price-index-', 'price-fixture-'];
const EXTRA = ['firestore-rules.price-ledger.test.js'];
const LEGACY = 'price-book-2026-10-02.test.js';
const REAL_LABELS = ['Home Depot', "Lowe's", 'Lowes', 'Menards', 'ABC Supply', 'SRS Distribution', 'QXO', 'Beacon', 'Gulfeagle', 'Gulf Eagle', 'Modern Builders'];
const MONEY_KEYS = ['priceMicros', 'priceCents', 'extCents', 'listCents'];

const startsWithAny = (name, list) => list.some((p) => name.indexOf(p) === 0);
const allTests = fs.readdirSync(TESTS).filter((f) => f.slice(-8) === '.test.js');
const inScope = allTests.filter((f) => startsWithAny(f, PREFIXES) || EXTRA.indexOf(f) !== -1);
const fixtureFiles = fs.existsSync(FIXTURES) ? fs.readdirSync(FIXTURES) : [];
const scanned = inScope.map((f) => path.join(TESTS, f)).concat(fixtureFiles.map((f) => path.join(FIXTURES, f)));

/** Every match of a global regex, as [index, groups...]. */
function every(re, text) {
  const out = []; let m;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) { out.push(m); if (m[0] === '') re.lastIndex++; }
  return out;
}
/** Lines of a file with their offsets, minus the ones that end "// derived". */
function inputLines(text) {
  const lines = []; let at = 0;
  text.split('\n').forEach((line) => {
    const bare = line.replace(/\s+$/, '');
    if (bare.slice(-10) !== '// derived') lines.push({ at, line });
    at += line.length + 1;
  });
  return lines;
}
const MONEY_RE = new RegExp('(?:' + MONEY_KEYS.join('|') + ')["\']?\\s*:\\s*(-?\\d+(?:\\.\\d+)?)', 'g');
const SKU_RE = /(?:^|[^A-Za-z])sku["']?\s*:\s*(["'])([^"']*)\1/g;

console.log('\nScope');
{
  const stray = allTests.filter((f) => f.indexOf('price-') === 0 && inScope.indexOf(f) === -1 && f !== LEGACY);
  ok('every tests/price-*.test.js is in scope, or is the pinned legacy suite', stray.length === 0, stray);
  ok('the scope holds the ledger suites and the fixture', ['price-logic-2026-11.test.js', 'price-ledger-server-2026-11.test.js', 'price-fixture-privacy.test.js', 'firestore-rules.price-ledger.test.js'].every((f) => inScope.indexOf(f) !== -1) && fixtureFiles.indexOf('ledger-basic.json') !== -1, [inScope, fixtureFiles]);
  ok('the legacy price-book suite is not scanned (it is pinned until it is retired)', inScope.indexOf(LEGACY) === -1);
  ok('no spreadsheet, CSV or PDF is tracked under tests/fixtures/pricing/', fixtureFiles.every((f) => ['.csv', '.xlsx', '.xls', '.pdf'].indexOf(path.extname(f).toLowerCase()) === -1), fixtureFiles);
}

console.log('\nMoney, SKUs and supplier names');
{
  const badMoney = [], badSku = [], near = [];
  let moneyCount = 0, skuCount = 0;
  scanned.forEach((file) => {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (rel === 'tests/price-fixture-privacy.test.js') return;      // this file names the real labels as its own list
    const text = fs.readFileSync(file, 'utf8');
    inputLines(text).forEach(({ at, line }) => {
      every(MONEY_RE, line).forEach((m) => {
        moneyCount++;
        const digits = m[1].replace('-', '').replace('.', '');
        if (Number(digits) % 1111 !== 0) badMoney.push(rel + ': ' + m[0]);
        const from = Math.max(0, at + m.index - 200), to = Math.min(text.length, at + m.index + m[0].length + 200);
        const around = text.slice(from, to);
        REAL_LABELS.forEach((label) => { if (around.indexOf(label) !== -1) near.push(rel + ': "' + label + '" near ' + m[0]); });
      });
      every(SKU_RE, line).forEach((m) => {
        skuCount++;
        if (m[2] !== '' && m[2].indexOf('TEST-') !== 0) badSku.push(rel + ': ' + m[0].trim());
      });
    });
  });
  ok('the scan found money literals and SKUs to check (it is not vacuous)', moneyCount >= 20 && skuCount >= 3, [moneyCount, skuCount]);
  ok('every input money literal is a multiple of 1111', badMoney.length === 0, badMoney.slice(0, 8));
  ok('every SKU literal is empty or starts TEST-', badSku.length === 0, badSku.slice(0, 8));
  ok('no real supplier label sits within 200 characters of a money literal', near.length === 0, near.slice(0, 8));

  // the scanner itself: each rule fires on a planted line
  const planted = 'const a = { sku: "0670070", priceMicros: 12345678 };\nconst b = { priceMicros: 92583 }; // derived\n';
  const hits = [];
  inputLines(planted).forEach(({ line }) => { every(MONEY_RE, line).forEach((m) => hits.push(m[1])); every(SKU_RE, line).forEach((m) => hits.push(m[2])); });
  ok('a planted real-looking SKU and price are caught; a "// derived" line is skipped', JSON.stringify(hits) === JSON.stringify(['12345678', '0670070']), hits);
}

console.log('\nClient files stay inside the cost-privacy scan');
{
  const guard = fs.readFileSync(path.join(TESTS, 'catalog-cost-privacy.test.js'), 'utf8');
  const start = guard.indexOf('const STRICT_EXEMPT = {');
  const end = guard.indexOf('\n};', start);
  const block = start === -1 ? null : guard.slice(start, end);
  ok('STRICT_EXEMPT was found in tests/catalog-cost-privacy.test.js', block !== null && block.length > 50);
  ok('no docs/pro/js/price-*.js or docs/pro/css/price-*.css path is exempt from it', block !== null && block.indexOf('pro/js/price-') === -1 && block.indexOf('pro/css/price-') === -1);
}

console.log('\nOnly price-logic.js converts money');
{
  const dirs = [['functions', '.js'], ['docs/pro/js', '.js'], ['docs/pro/css', '.css']];
  const files = [];
  dirs.forEach(([dir, ext]) => {
    fs.readdirSync(path.join(ROOT, dir)).forEach((f) => {
      if (f.indexOf('price-') === 0 && f.slice(-ext.length) === ext && f !== 'price-logic.js' && f !== 'price-book.js' && f !== 'price-book.css') files.push(dir + '/' + f);
    });
  });
  const banned = ['/ 100', '* 100', 'parseFloat(', 'toFixed('];
  const found = [];
  files.forEach((rel) => {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    banned.forEach((b) => { if (text.indexOf(b) !== -1) found.push(rel + ': ' + b); });
  });
  ok('the ledger files outside price-logic.js were found', files.indexOf('functions/price-ledger.js') !== -1 && files.indexOf('functions/price-ledger-store.js') !== -1, files);
  ok('none of them divides or multiplies by 100, or uses parseFloat or toFixed', found.length === 0, found);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
