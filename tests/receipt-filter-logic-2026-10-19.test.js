/**
 * tests/receipt-filter-logic-2026-10-19.test.js
 *
 * docs/pro/js/receipt-filter-logic.js — the pure search / filter / sort /
 * bulk-assign rules behind the Home Depot receipt import review — driven in a
 * vm sandbox with SYNTHETIC leads and receipts (public repo). Then pins the
 * wiring: the new UI is behind the receiptSorterQueue flag (no new flag), is
 * loaded by the expenses bundle, uses no inline style/handlers, and the CSS
 * has the phone card layout, 44px targets and reduced-motion guard.
 *
 * Source assertions strip comments first so a comment cannot satisfy them.
 *
 * Run: node tests/receipt-filter-logic-2026-10-19.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

const win = {}; win.window = win;
vm.createContext(win);
vm.runInContext(read('docs/pro/js/receipt-filter-logic.js'), win);
const F = win.NBDReceiptFilter;

const LEADS = [
  { id: 'a', customerId: 'NBD-0042', firstName: 'Robert', lastName: 'Smith', address: '12 Ashgrove Ave, Town, OH', stage: 'Scheduled' },
  { id: 'b', customerId: 'NBD-0043', firstName: 'Sam', lastName: 'Smith', address: '40 Birch Ln, Town, OH', stage: 'Closed' },
  { id: 'c', customerId: 'NBD-0044', firstName: 'Lora', lastName: 'Mueller', address: '6389 Muellers Lake Ln, Milford, OH', stage: 'Install' },
  { id: 'd', customerId: 'NBD-0045', name: 'Acme Holdings LLC', address: '4127 Lora Ave, Town, OH', stage: 'Estimate' },
  { id: 'e', customerId: 'NBD-0046', firstName: 'Del', lastName: 'Ray', address: 'Town, OH', deleted: true },
];
const ids = (res) => res.map((x) => x.lead.id).join(',');

console.log('\n1. job picker: search');
{
  ok('empty query lists every live job (deleted hidden)', ids(F.searchLeads(LEADS, '')).split(',').sort().join() === 'a,b,c,d');
  ok('case-insensitive name match', ids(F.searchLeads(LEADS, 'MUELLER')) === 'c');
  ok('multi-word AND: "smith sam" finds only Sam', ids(F.searchLeads(LEADS, 'smith sam')) === 'b');
  ok('multi-word AND: words in any order across name + street', ids(F.searchLeads(LEADS, 'ash robert')) === 'a');
  ok('matches the street', ids(F.searchLeads(LEADS, 'birch')) === 'b');
  ok('matches the customer #', ids(F.searchLeads(LEADS, 'nbd-0044')) === 'c');
  ok('matches the lead id', ids(F.searchLeads(LEADS, 'a ashgrove')) === 'a');
  ok('matches the status / stage', ids(F.searchLeads(LEADS, 'closed')) === 'b');
  ok('a word that matches nothing returns nothing', F.searchLeads(LEADS, 'smith zzz').length === 0);
  ok('a deleted job never shows, even by exact name', F.searchLeads(LEADS, 'ray').length === 0);
  ok('"lora" finds the customer AND the Lora Ave street', ids(F.searchLeads(LEADS, 'lora')).split(',').sort().join() === 'c,d');
  ok('a name that starts with the word ranks above a mid-address hit', ids(F.searchLeads(LEADS, 'lora')) === 'c,d');
  ok('limit is honoured', F.searchLeads(LEADS, '', { limit: 2 }).length === 2);
}

console.log('\n2. job picker: best matches and recents stay pinned on top');
{
  const r = F.searchLeads(LEADS, '', { pinned: ['d', 'b'], recent: ['c'] });
  ok('best matches first, in the row\'s order', ids(r).startsWith('d,b,c'));
  ok('group labels: best → recent → all', r.map((x) => x.group).join() === 'best,best,recent,all');
  const q = F.searchLeads(LEADS, 'smith', { pinned: ['b'] });
  ok('a pinned job that matches the typed text stays first', ids(q) === 'b,a');
  ok('a pinned job that does NOT match the typed text is filtered out', ids(F.searchLeads(LEADS, 'robert', { pinned: ['b'] })) === 'a');
  ok('a job pinned and recent shows once', ids(F.searchLeads(LEADS, '', { pinned: ['a'], recent: ['a', 'b'] })).split(',').filter((x) => x === 'a').length === 1);
  ok('a pinned id that is deleted / unknown is ignored', ids(F.searchLeads(LEADS, '', { pinned: ['e', 'nope'] })).indexOf('e') === -1);
}

const ROWS = [
  { key: 'k1', date: '2026-10-10', store: '3822', storeName: 'Western Hills', jobName: 'Smith roof', projectName: '', totalCents: 24350, taxCents: 1350, leadId: 'a', include: true, already: false, items: [{ desc: 'GAF Timberline Shingle', sku: '100200' }], match: { status: 'suggested', candidates: ['a'] } },
  { key: 'k2', date: '2026-10-12', store: '3844', storeName: 'Milford', jobName: '', projectName: '', totalCents: 5120, taxCents: 290, leadId: null, include: true, already: false, items: [{ desc: 'Roofing nails 1-1/4', sku: '555' }], match: { status: 'none', candidates: [] } },
  { key: 'k3', date: '2026-10-01', store: '3822', storeName: 'Western Hills', jobName: 'SHOP', projectName: '', totalCents: 99900, taxCents: 5600, leadId: null, include: false, already: false, items: [], match: { status: 'overhead', candidates: [] } },
  { key: 'k4', date: '2026-09-20', store: '3822', storeName: 'Western Hills', jobName: 'NBD-0043', projectName: '', totalCents: 15000, taxCents: 800, leadId: 'b', include: false, already: true, items: [], match: { status: 'code', candidates: ['b'] } },
  { key: 'k5', date: '2026-10-14', store: '3844', storeName: 'Milford', jobName: 'NBD-0044 Mueller', projectName: '', totalCents: 8000, taxCents: 450, leadId: 'c', include: true, already: false, items: [], match: { status: 'code', candidates: ['c'] } },
];
const labelFor = (id) => ({ a: 'NBD-0042 · Robert Smith — 12 Ashgrove Ave', b: 'NBD-0043 · Sam Smith — 40 Birch Ln', c: 'NBD-0044 · Lora Mueller — 6389 Muellers Lake Ln' }[id] || '');
const keys = (rows) => rows.map((r) => r.key).join(',');
const flt = (patch) => F.filterRows(ROWS, Object.assign({}, F.DEFAULT_FILTERS, patch), { labelFor });

console.log('\n3. review table: text search');
{
  ok('default filters show everything', flt({}).length === 5);
  ok('PO / job name', keys(flt({ q: 'smith roof' })) === 'k1');
  ok('item description', keys(flt({ q: 'timberline' })) === 'k1');
  ok('SKU', keys(flt({ q: '555' })) === 'k2');
  ok('store name', keys(flt({ q: 'milford' })) === 'k2,k5');
  ok('store number', keys(flt({ q: '#3844' })) === 'k2,k5');
  ok('amount as typed with a $ sign', keys(flt({ q: '$243.50' })) === 'k1');
  ok('amount without the $', keys(flt({ q: '51.20' })) === 'k2');
  ok('vendor name', flt({ q: 'home depot' }).length === 5);
  ok('multi-word AND across fields', keys(flt({ q: 'milford nbd-0044' })) === 'k5');
  ok('matches the assigned job\'s customer (by label)', keys(flt({ q: 'sam smith' })) === 'k4');
  ok('case-insensitive', keys(flt({ q: 'GAF TIMBERLINE' })) === 'k1');
  ok('no match → nothing', flt({ q: 'zzz' }).length === 0);
}

console.log('\n4. review table: filters');
{
  ok('assigned', keys(flt({ assign: 'assigned' })) === 'k1,k4,k5');
  ok('unassigned', keys(flt({ assign: 'unassigned' })) === 'k2,k3');
  ok('selected excludes already-imported rows', keys(flt({ assign: 'selected' })) === 'k1,k2,k5');
  ok('not selected excludes already-imported rows', keys(flt({ assign: 'unselected' })) === 'k3');
  ok('already imported', keys(flt({ assign: 'imported' })) === 'k4');
  ok('date from (inclusive)', keys(flt({ from: '2026-10-12' })) === 'k2,k5');
  ok('date to (inclusive)', keys(flt({ to: '2026-10-01' })) === 'k3,k4');
  ok('date range', keys(flt({ from: '2026-10-01', to: '2026-10-12' })) === 'k1,k2,k3');
  ok('min amount (inclusive, dollars → cents)', keys(flt({ min: '150' })) === 'k1,k3,k4');
  ok('max amount (inclusive)', keys(flt({ max: '80' })) === 'k2,k5');
  ok('amount range', keys(flt({ min: '$50', max: '$100.00' })) === 'k2,k5');
  ok('a blank / junk amount box does not filter', flt({ min: 'abc', max: '' }).length === 5);
  ok('store', keys(flt({ store: '3844' })) === 'k2,k5');
  ok('filters combine (AND)', keys(flt({ store: '3822', assign: 'unassigned' })) === 'k3');
  ok('an unknown "show" value falls back to all', flt({ assign: 'bogus' }).length === 5);
  ok('storeOptions lists each store once with its name', JSON.stringify(F.storeOptions(ROWS).map((s) => s.label)) === '["Western Hills #3822","Milford #3844"]');
}

console.log('\n5. review table: sort, counts and totals');
{
  const s = (k) => keys(F.sortRows(ROWS, k, { labelFor }));
  ok('newest first', s('date-desc') === 'k5,k2,k1,k3,k4');
  ok('oldest first', s('date-asc') === 'k4,k3,k1,k2,k5');
  ok('biggest total', s('amount-desc') === 'k3,k1,k4,k5,k2');
  ok('smallest total', s('amount-asc') === 'k2,k5,k4,k1,k3');
  ok('no job first (stable inside each group)', s('unassigned-first') === 'k2,k3,k1,k4,k5');
  ok('an unknown sort falls back to newest', s('bogus') === 'k5,k2,k1,k3,k4');
  ok('sorting does not mutate the input', keys(ROWS) === 'k1,k2,k3,k4,k5');
  const vis = flt({ store: '3844' });
  const t = F.totals(ROWS, vis);
  ok('visible count and total', t.visible === 2 && t.total === 5 && t.visibleCents === 13120);
  ok('selected-in-view count and cents (imported rows never count)', t.selectedVisible === 2 && t.selectedVisibleCents === 13120);
  const t2 = F.totals(ROWS, flt({ store: '3822' }));
  ok('selected across all rows is reported separately', t2.selectedVisible === 1 && t2.selectedAll === 3 && t2.selectedAllCents === 37470);
}

console.log('\n6. filters: defaults, cleaning, clearing');
{
  ok('defaults are "default"', F.isDefault(F.DEFAULT_FILTERS));
  ok('any change is not default', !F.isDefault(Object.assign({}, F.DEFAULT_FILTERS, { min: '5' })));
  const c = F.cleanFilters({ q: 'x', assign: 'nope', sort: 'nope', from: 5, evil: '<b>' });
  ok('cleanFilters repairs a bad enum and drops unknown keys / non-strings', c.assign === 'all' && c.sort === 'date-desc' && c.from === '' && c.evil === undefined && c.q === 'x');
  ok('cleanFilters caps a runaway string', F.cleanFilters({ q: 'a'.repeat(500) }).q.length === 80);
  ok('dollarsToCents', F.dollarsToCents('$1,200.50') === 120050 && F.dollarsToCents('') === null && F.dollarsToCents('-3') === null);
}

console.log('\n7. bulk assign: which visible rows it may touch');
{
  const t = F.bulkTargets(ROWS, 'a');
  ok('an already-imported row is never touched', t.apply.every((r) => !r.already) && t.skipped.some((s) => s.row.key === 'k4' && s.why === 'imported'));
  ok('a customer-# match on ANOTHER job is left alone', t.skipped.some((s) => s.row.key === 'k5' && s.why === 'matched'));
  ok('everything else is assigned', keys(t.apply) === 'k1,k2,k3');
  const same = F.bulkTargets(ROWS, 'c');
  ok('a customer-# match on the SAME job is allowed', same.apply.some((r) => r.key === 'k5'));
  ok('only the rows handed in are considered (view-scoped)', keys(F.bulkTargets(flt({ store: '3844' }), 'a').apply) === 'k2');
}

console.log('\n8. wiring (comments stripped)');
{
  const hd = stripJs(read('docs/pro/js/hd-import.js'));
  ok('hd-import gates the new review on the EXISTING receiptSorterQueue flag', /enabled\('receiptSorterQueue'\)/.test(hd) && /NBDReceiptReviewUI/.test(hd));
  ok('the legacy table is still the fallback (flag off → unchanged)', /const body = rows\.map\(\(r, i\) =>/.test(hd) && /data-hd-lead=/.test(hd));
  ok('hd-import creates no new flag name', !/enabled\('(?!receiptSorterAliases|receiptSorterQueue)[A-Za-z]+'\)/.test(hd));
  const ui = stripJs(read('docs/pro/js/receipt-review-ui.js'));
  ok('the UI file writes nothing to Firestore', !/setDoc|addDoc|updateDoc|deleteDoc|writeBatch|localStorage/.test(ui));
  ok('filters are remembered per session only', /sessionStorage/.test(ui));
  ok('no inline style attribute or inline handler is generated', !/\bstyle\s*=/.test(ui) && !/\bon[a-z]+\s*=\s*["'\\]/i.test(ui));
  ok('Escape closes the picker, arrows move, Enter picks', /'Escape'/.test(ui) && /'ArrowDown'/.test(ui) && /'ArrowUp'/.test(ui) && /'Enter'/.test(ui));
  ok('bulk assign has an explicit confirm step', /bulk-confirm/.test(ui) && /Nothing is saved until you press Import/.test(ui));
  ok('combobox / listbox roles are set', /role="combobox"/.test(ui) && /role="listbox"/.test(ui) && /aria-activedescendant/.test(ui));
  ok('user text is escaped into the picker list', /esc\(C\.leadLabel\(l\)\)/.test(ui));
  const loader = stripJs(read('docs/pro/js/script-loader.js'));
  ok('the expenses bundle loads the three new files', /receipt-review\.css/.test(loader) && /receipt-filter-logic\.js/.test(loader) && /receipt-review-ui\.js/.test(loader));
  ok('hd-import cache key was bumped', !/hd-import\.js\?v=3/.test(loader) && /hd-import\.js\?v=4/.test(loader));
  const css = stripCss(read('docs/pro/css/receipt-review.css'));
  ok('CSS: phone card layout under 480px', /@media \(max-width: 480px\)[\s\S]*display: block/.test(css));
  ok('CSS: 44px touch targets on the inputs, buttons and picker rows', (css.match(/min-height: 44px/g) || []).length >= 6);
  ok('CSS: reduced motion respected (transitions only when no-preference)', /@media \(prefers-reduced-motion: no-preference\)\s*\{[^}]*transition/.test(css) && !/^[^@\n]*transition/m.test(css.replace(/@media \(prefers-reduced-motion: no-preference\)[\s\S]*?\n\}/, '')));
  ok('CSS: rounded (14px cards, pill buttons)', /--rv-r: 14px/.test(css) && /border-radius: 999px/.test(css));
  const hex = (css.match(/#[0-9a-fA-F]{3,8}\b/g) || []).filter((h) => !/^#(fff|BD5728|12223D|2a2f37|9ca3af|16a34a|d97706|dc2626|3b82f6)$/i.test(h));
  ok('CSS: no stray hardcoded colours (only token fallbacks)', hex.length === 0, hex.join(','));
  ok('CSS: no sideways scroll on the phone (cards are block, wrap long text)', /overflow-wrap: anywhere/.test(css));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
