/**
 * tests/price-import-2026-11.test.js
 *
 * Slice 3 of the supplier price ledger (Jo, 2026-11-17): the import screen's pure
 * logic in functions/price-logic.js (mirrored into docs/pro/js/price-logic.js), and
 * the browser's chunked send in docs/pro/js/price-ledger.js, run in a vm.
 *
 *   - parseCsv: quotes, commas inside quotes, CRLF, a BOM, blank lines
 *   - guessColumns / guessHeaderRow: the usual header words of a supplier sheet
 *   - buildImport: the document kind (quote, price sheet, invoice), "good through"
 *     required on a quote, tax asked with no default, per C / per M, a row with no
 *     unit or an unknown unit counts as "needs a unit" and is still sent as stated,
 *     a row with no item number or no price is rejected, new items are counted,
 *     the file name and date become the document reference, the file is not kept
 *   - importRows sends 500 rows a call on channel csv_import and adds the counts
 *
 * Every price is synthetic (a multiple of 1111), suppliers are fictional and every
 * SKU starts TEST-. tests/price-fixture-privacy.test.js scans this file.
 *
 * Run: node tests/price-import-2026-11.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

const ROOT = path.join(__dirname, '..');
const L = require(path.join(ROOT, 'functions', 'price-logic.js'));
const NOW = Date.UTC(2026, 10, 17, 15, 0, 0);

console.log('\nparseCsv');
{
  const t = '﻿Item #,Description,Price,UOM\r\nTEST-0001,"Shingle, slate ""HD""",11.11,BD\r\n\r\nTEST-0002,Ridge,22.22,BDL\n';
  const rows = L.parseCsv(t);
  ok('a BOM, CRLF, a quoted comma and a doubled quote are read; the blank line is dropped',
    rows.length === 3 && rows[0][0] === 'Item #' && rows[1][1] === 'Shingle, slate "HD"' && rows[2][0] === 'TEST-0002' && rows[2][3] === 'BDL', rows);
  ok('an empty file is no rows', L.parseCsv('').length === 0 && L.parseCsv(null).length === 0);
  ok('a last line with no newline is kept', L.parseCsv('a,b\nc,d').length === 2);
}

console.log('\nguessColumns / guessHeaderRow');
{
  const g = L.guessColumns(['Item #', 'Description', 'Qty', 'U/M', 'Unit Price', 'Ext Price']);
  ok('item #, description, qty, U/M and unit price are found; the extended price is not the price',
    g.sku === 0 && g.title === 1 && g.qty === 2 && g.unit === 3 && g.price === 4, g);
  const h = L.guessColumns(['SKU', 'Product Name', 'Price', 'Per']);
  ok('sku, product name, price and a "per" column', h.sku === 0 && h.title === 1 && h.price === 2 && h.per === 3 && h.unit === -1, h);
  const live = L.guessColumns(['supplier', 'branch', 'item_code', 'description', 'unit', 'live_price']);
  ok('item_code, unit and live_price are found (the saved portal reads use them)', live.sku === 2 && live.title === 3 && live.unit === 4 && live.price === 5, live);
  ok('TUB is a tube', L.normaliseUom('TUB').unit === 'TUBE' && L.normaliseUom('tubs').unit === 'TUBE');
  const none = L.guessColumns(['foo', 'bar']);
  ok('unknown headers map to nothing', none.sku === -1 && none.price === -1, none);
  const table = [['Testco Supply price sheet'], ['Effective 2026-11-01'], ['Part Number', 'Desc', 'Net Price', 'UOM'], ['TEST-0001', 'A', '11.11', 'EA']];
  ok('the header row is the first row that names an item number and a price', L.guessHeaderRow(table) === 2);
  ok('with no recognisable header the first row is assumed', L.guessHeaderRow([['x', 'y'], ['1', '2']]) === 0);
}

const MAP = { sku: 0, title: 1, price: 2, unit: 3, per: -1, qty: -1 };
const base = (patch) => Object.assign({
  supplierId: 'other_testco', docKind: 'price_sheet', docDateOn: '2026-11-10', validThroughOn: null,
  taxIncluded: false, docRef: '', fileName: 'testco-sheet.csv', locationId: null, headerRow: 0, map: MAP, knownOfferIds: {}, nowMs: NOW,
}, patch || {});
const TABLE = [
  ['Item', 'Desc', 'Price', 'UOM'],
  ['TEST-0001', 'Testco shingle', '11.11', 'BD'],
  ['TEST-0002', 'Testco nails', '222.22', '/M'],
  ['TEST-0003', 'Testco drip edge', '3.3333', ''],
  ['TEST-0004', 'Testco mystery', '44.44', 'ZZ'],
  ['', 'No item number', '55.55', 'EA'],
  ['TEST-0006', 'No price', '', 'EA'],
  ['TEST-0007', 'Bad price', 'call', 'EA'],
  ['TEST-0008', 'Testco coil', '66.66', 'RL'],
];

console.log('\nbuildImport: the setup is checked before any row');
{
  ok('a quote needs its good-through date', L.buildImport(TABLE, base({ docKind: 'quote' })).reason === 'quote_needs_date');
  ok('tax is a required choice with no default', L.buildImport(TABLE, base({ taxIncluded: undefined })).reason === 'tax_required'
    && L.buildImport(TABLE, base({ taxIncluded: 'no' })).reason === 'tax_required');
  ok('a document kind outside quote, price sheet, invoice is refused', L.buildImport(TABLE, base({ docKind: 'manual' })).reason === 'bad_kind');
  ok('an unknown supplier is refused', L.buildImport(TABLE, base({ supplierId: 'nobody' })).reason === 'bad_supplier');
  ok('the item number and price columns must be mapped', L.buildImport(TABLE, base({ map: Object.assign({}, MAP, { price: -1 }) })).reason === 'map_required'
    && L.buildImport(TABLE, base({ map: Object.assign({}, MAP, { sku: -1 }) })).reason === 'map_required');
  ok('a document date after tomorrow is refused', L.buildImport(TABLE, base({ docDateOn: '2026-11-30' })).reason === 'bad_date');
  ok('a good-through date before the document date is refused', L.buildImport(TABLE, base({ docKind: 'quote', validThroughOn: '2026-11-01' })).reason === 'bad_valid_through');
}

console.log('\nbuildImport: rows, counts and what is sent');
{
  const known = {}; known[L.offerIdFor('other_testco', 'TEST-0001')] = true;
  const r = L.buildImport(TABLE, base({ knownOfferIds: known }));
  ok('setup accepted', r.ok === true, r.reason);
  ok('counts: 8 rows, 5 to send, 3 rejected, 3 need a unit, 4 new items',
    r.counts.rows === 8 && r.counts.send === 5 && r.counts.rejected === 3 && r.counts.needsUnit === 3 && r.counts.newItems === 4, r.counts);
  const byLine = {}; r.lines.forEach((l) => { byLine[l.sku || ('#' + l.line)] = l; });
  ok('a bundle row is read as stated, per one bundle', byLine['TEST-0001'].statedUnit === 'BDL' && byLine['TEST-0001'].per === 1 && byLine['TEST-0001'].priceMicros === 11110000 && byLine['TEST-0001'].status === 'ok' && byLine['TEST-0001'].isNew === false, byLine['TEST-0001']);
  ok('a per-M row with no base unit needs a unit and keeps per 1000', byLine['TEST-0002'].status === 'needs_unit' && byLine['TEST-0002'].per === 1000 && byLine['TEST-0002'].statedUnit === null, byLine['TEST-0002']);
  ok('four decimals are kept exactly, by digits', byLine['TEST-0003'].priceMicros === 3333300 && byLine['TEST-0003'].status === 'needs_unit', byLine['TEST-0003']);
  ok('an unknown unit is never guessed: the row needs a unit and keeps its own text', byLine['TEST-0004'].status === 'needs_unit' && byLine['TEST-0004'].statedUnit === null && byLine['TEST-0004'].uomRaw === 'ZZ', byLine['TEST-0004']);
  ok('no item number, no price and a word for a price are rejected with a reason',
    byLine['#6'].reason === 'no_item_number' && byLine['TEST-0006'].reason === 'bad_price' && byLine['TEST-0007'].reason === 'bad_price', [byLine['#6'], byLine['TEST-0006']]);
  const row = r.rows.find((x) => x.offer.sku === 'TEST-0008');
  ok('a sent row carries the stub, the kind, tax as chosen, the date and the file as the reference',
    row && row.offerId === L.offerIdFor('other_testco', 'TEST-0008') && row.kind === 'price_sheet' && row.taxIncluded === false
      && row.observedOn === '2026-11-10' && row.doc.type === 'price_sheet' && row.doc.ref === 'testco-sheet.csv'
      && row.offer.supplierId === 'other_testco' && row.offer.title === 'Testco coil' && row.statedUnit === 'RL' && row.uomRaw === 'RL', row);
  ok('a row with no unit is sent with a null unit and its own text kept', r.rows.find((x) => x.offer.sku === 'TEST-0003').statedUnit === null);
  ok('nothing about the file but its name is kept on a row', r.rows.every((x) => Object.keys(x).every((k) => ['offerId', 'kind', 'priceMicros', 'per', 'statedUnit', 'uomRaw', 'qty', 'priceType', 'taxIncluded', 'observedOn', 'validThroughOn', 'locationId', 'doc', 'note', 'offer'].indexOf(k) !== -1)), Object.keys(r.rows[0]));

  const q = L.buildImport(TABLE, base({ docKind: 'quote', validThroughOn: '2026-12-10', docRef: 'TEST-Q-0009' }));
  ok('a quote: kind quote, good-through carried, the typed document number wins over the file name',
    q.rows[0].kind === 'quote' && q.rows[0].validThroughOn === '2026-12-10' && q.rows[0].doc.ref === 'TEST-Q-0009', q.rows[0]);
  const inv = L.buildImport(TABLE, base({ docKind: 'invoice', taxIncluded: true }));
  ok('an invoice is a paid row on an invoice document, tax as chosen, no good-through',
    inv.rows[0].kind === 'paid' && inv.rows[0].doc.type === 'invoice' && inv.rows[0].taxIncluded === true && inv.rows[0].validThroughOn === null, inv.rows[0]);
  const noName = L.buildImport(TABLE, base({ fileName: '', docRef: '' }));
  ok('with no file name and no number the reference is kind-date-branch', noName.rows[0].doc.ref === 'price_sheet-2026-11-10-all', noName.rows[0].doc);

  const perCol = L.buildImport([['Item', 'Desc', 'Price', 'UOM', 'Per'], ['TEST-0010', 'Nails', '111.10', 'BX', 'C'], ['TEST-0011', 'Vent', '22.22', 'EA', 'Q']],
    base({ map: { sku: 0, title: 1, price: 2, unit: 3, per: 4, qty: -1 } }));
  ok('a per column reads C as per 100', perCol.lines[0].per === 100 && perCol.lines[0].statedUnit === 'BX' && perCol.lines[0].status === 'ok', perCol.lines[0]);
  ok('a per value nobody knows is rejected', perCol.lines[1].status === 'rejected' && perCol.lines[1].reason === 'bad_per', perCol.lines[1]);

  const big = [['Item', 'Desc', 'Price', 'UOM']];
  for (let i = 0; i < 5001; i++) big.push(['TEST-' + i, 'x', '1.111', 'EA']);
  ok('a file over 5000 rows is refused before any row is built', L.buildImport(big, base()).reason === 'too_many_rows');

  const dupe = L.buildImport([['Item', 'Desc', 'Price', 'UOM'], ['TEST-0001', 'a', '11.11', 'BD'], ['TEST-0001', 'a', '11.11', 'BD']], base());
  ok('one new SKU on two lines is one new item', dupe.counts.newItems === 1 && dupe.counts.send === 2, dupe.counts);
}

console.log('\nThe server accepts what the import builds');
{
  const r = L.buildImport(TABLE, base());
  const ctx = { channel: 'csv_import', nowMs: NOW };
  const res = r.rows.map((row) => L.sanitizeObservation(row, ctx));
  ok('every sent row passes the server sanitizer on channel csv_import', res.every((x) => x.ok), res.filter((x) => !x.ok));
  const noUnit = res.find((x) => x.value.offerId === L.offerIdFor('other_testco', 'TEST-0003'));
  ok('a no-unit row is kept as stated (null unit), with its stub', noUnit.value.statedUnit === null && noUnit.value.offer && noUnit.value.offer.sku === 'TEST-0003', noUnit.value);
  const rawUnit = L.sanitizeObservation(Object.assign({}, r.rows[0], { statedUnit: null, uomRaw: 'ZZ' }), ctx);
  ok('on csv_import a null unit with odd unit text is kept as stated, the text in uomRaw', rawUnit.ok && rawUnit.value.statedUnit === null && rawUnit.value.uomRaw === 'ZZ', rawUnit);
  ok('csv_import is a no-unit channel', L.NULL_UNIT_CHANNELS.indexOf('csv_import') !== -1);
  ok('csv_import takes only paid, quote, contract and price sheet', L.sanitizeObservation(Object.assign({}, r.rows[0], { kind: 'manual' }), ctx).reason === 'bad_kind'
    && L.sanitizeObservation(Object.assign({}, r.rows[0], { kind: 'portal_read' }), ctx).reason === 'bad_kind');
  ok('a csv_import quote with no good-through is refused', L.sanitizeObservation(Object.assign({}, r.rows[0], { kind: 'quote', validThroughOn: null }), ctx).reason === 'quote_needs_date');
  ok('a csv_import row with no document reference is refused', L.sanitizeObservation(Object.assign({}, r.rows[0], { doc: { type: 'price_sheet', ref: '' } }), ctx).reason === 'needs_doc_ref');
  ok('the typed channel still refuses a row with no unit', L.sanitizeObservation(Object.assign({}, r.rows[0], { statedUnit: null, uomRaw: null }), { channel: 'manual', nowMs: NOW }).reason === 'needs_unit');
  ok('the store-export channel still refuses unit text nobody knows', L.sanitizeObservation(Object.assign({}, r.rows[0], { statedUnit: null, uomRaw: 'ZZ' }), { channel: 'hd_csv', nowMs: NOW }).reason === 'needs_unit');
}

console.log('\nThe browser sends 500 rows a call on csv_import');
{
  const calls = [];
  const sandbox = {
    console, Promise, Object, Array, String, Number, Math, Date, JSON, Error, Set, Map, RegExp, isFinite, unescape, encodeURIComponent,
    addEventListener: () => {}, document: { querySelector: () => null },
    NBDFlags: { enabled: (f) => f === 'supplierPricing' },
    _userClaims: { companyId: 'co-a', role: 'company_admin' }, _user: { uid: 'u_ca' },
    _functions: {}, _httpsCallable: (fns, name) => async (data) => {
      calls.push({ name, n: data.rows.length, channel: data.channel });
      return { data: { written: data.rows.length - 1, duplicates: 1, rejected: 0, needsUnit: 0, results: data.rows.map((x, i) => ({ i, status: i === 0 ? 'duplicate' : 'written' })) } };
    },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'docs/pro/js/price-logic.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'docs/pro/js/price-ledger.js'), 'utf8'), sandbox);
  const PL = sandbox.NBDPriceLedger;
  const rows = [];
  for (let i = 0; i < 1201; i++) rows.push({ offerId: 'other_testco_TEST-' + i, kind: 'price_sheet', priceMicros: 1111 });
  (async () => {
    const progress = [];
    const out = await PL.importRows(rows, (done, total) => progress.push(done + '/' + total));
    ok('three calls of 500, 500 and 201, all on csv_import', calls.length === 3 && calls[0].n === 500 && calls[2].n === 201 && calls.every((c) => c.name === 'priceLedgerRecord' && c.channel === 'csv_import'), calls);
    ok('the counts are added up', out.ok === true && out.written === 1198 && out.duplicates === 3 && out.sent === 1201, out);
    ok('progress is reported after each call', progress.join(',') === '500/1201,1000/1201,1201/1201', progress);
    sandbox._userClaims = { companyId: 'co-a', role: 'manager' };
    calls.length = 0;
    const mgr = await PL.importRows(rows.slice(0, 3));
    ok('a manager sends nothing (owner and company admins only)', mgr.ok === false && calls.length === 0, mgr);
    finish();
  })().catch((e) => { console.error(e); process.exit(1); });
}

function finish() {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
}
