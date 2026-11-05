/**
 * tests/invoice-supplement-chip-2026-11-04.test.js
 *
 * The read-only "Includes $X in supplements" chip on the customer page's invoice rows. It only reads the invoice's stored
 * supplementTotal; it never compares against the estimate (a deposit + final job would make that misleading) and fails closed on
 * anything odd. Also pins the wiring in customer.html / customer-tasks-ui.js and that the markup has no inline style or handler.
 *
 * Run: node tests/invoice-supplement-chip-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const S = require(path.join(ROOT, 'docs', 'pro', 'js', 'invoice-supplement-chip-logic.js'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const inv = (o) => Object.assign({ id: 'i1', status: 'sent', total: 12500, supplementTotal: 1250 }, o || {});

console.log('\n1. what it shows');
{
  ok('a supplement on an invoice reads in dollars and cents', S.chipText(inv()) === 'Includes $1,250.00 in supplements', S.chipText(inv()));
  ok('cents are kept (no float drift)', S.chipText(inv({ supplementTotal: 1250.35 })) === 'Includes $1,250.35 in supplements' && S.supplementCents(inv({ supplementTotal: 0.1 + 0.2 })) === 30);
  ok('a string amount with $ and commas is read', S.chipText(inv({ supplementTotal: '$1,250.50' })) === 'Includes $1,250.50 in supplements');
  ok('the whole invoice can be a supplement (equal to the total)', S.supplementCents(inv({ total: 1250, supplementTotal: 1250 })) === 125000);
  ok('works for any live status', ['draft', 'sent', 'viewed', 'partial', 'paid', 'overdue'].every((st) => S.supplementCents(inv({ status: st })) === 125000));
}

console.log('\n2. it shows nothing when it cannot be sure');
{
  ok('no supplement, zero, negative, blank, junk', [undefined, null, 0, '0', '', -50, 'abc', NaN].every((v) => S.supplementCents(inv({ supplementTotal: v })) === 0) && S.supplementCents({ total: 100 }) === 0);
  ok('more than the invoice total is nonsense, so nothing', S.supplementCents(inv({ total: 1000, supplementTotal: 1250 })) === 0);
  ok('no invoice total, or a zero one, means nothing to compare with', S.supplementCents(inv({ total: undefined })) === 0 && S.supplementCents(inv({ total: 0 })) === 0 && S.supplementCents(inv({ total: 'x' })) === 0);
  ok('cancelled, void and deleted invoices show nothing', ['cancelled', 'canceled', 'void', 'voided', 'CANCELLED'].every((st) => S.supplementCents(inv({ status: st })) === 0) && S.supplementCents(inv({ deleted: true })) === 0);
  ok('null, a number or a string instead of an invoice: nothing, no throw', S.supplementCents(null) === 0 && S.supplementCents(5) === 0 && S.supplementCents('x') === 0 && S.chipHtml(null) === '');
  const o = inv(), before = JSON.stringify(o);
  S.chipHtml(o);
  ok('never mutates the invoice', JSON.stringify(o) === before);
}

console.log('\n3. the markup');
{
  const h = S.chipHtml(inv(), (s) => String(s).toUpperCase());
  ok('uses the page\'s escaper on the text and carries the hook attribute', h === '<span class="ipx-sup-chip" data-supplement-chip>INCLUDES $1,250.00 IN SUPPLEMENTS</span>', h);
  ok('has its own escaper when none is passed', S.chipHtml(inv()).includes('Includes $1,250.00 in supplements') && !/<script/i.test(S.chipHtml(inv())));
  ok('no inline style or handler', !/style=|\son[a-z]+=/i.test(S.chipHtml(inv())));
  ok('empty string, not an empty chip, when there is nothing to say', S.chipHtml(inv({ supplementTotal: 0 })) === '');
}

console.log('\n4. wired into the customer page');
{
  const html = read('docs/pro/customer.html'), ui = read('docs/pro/js/customer-tasks-ui.js'), css = read('docs/pro/css/invoice-pipeline.css');
  const at = (s) => html.indexOf(s);
  ok('the logic loads once, deferred, versioned', (html.match(/<script defer src="js\/invoice-supplement-chip-logic\.js\?v=\d+"><\/script>/g) || []).length === 1);
  ok('the invoice row shows the chip next to the other badges', /const supChip = \(inv\) => \(window\.NBDInvoiceSupplement \? window\.NBDInvoiceSupplement\.chipHtml\(inv, esc\) : ''\);/.test(ui) && /\$\{stripeBadge\(inv\)\}\s*\n\s*\$\{supChip\(inv\)\}/.test(ui));
  ok('the chip has a style rule in the invoice stylesheet', /\.ipx-sup-chip/.test(css));
  ok('both changed assets were version-bumped so phones refetch them', /js\/customer-tasks-ui\.js\?v=(4[2-9]|[5-9]\d)/.test(html) && /css\/invoice-pipeline\.css\?v=([6-9]|\d\d)/.test(html));
  ok('nothing else computes money from it', !/NBDInvoiceSupplement[\s\S]{0,200}(total|subtotal|balanceDue)\s*[-+*]/.test(ui));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
