/**
 * tests/price-ledger-photos-2026-11.test.js
 *
 * Product photos for the supplier price ledger (2026-11-18, Jo: the owner and
 * admins add them; they show on the product card and the Stores & prices sheet,
 * inside the CRM only). functions/price-ledger-store.js saveOps.savePhoto against an
 * in-memory Firestore and Storage; the re-encode and sharp are stubbed, so this
 * proves the wiring, not sharp (functions/photo-reencode.js has its own tests).
 *
 *   - a product's photo goes on productLinks/{id}.photo, never on the product row,
 *     and leaves the approval markers (applied) alone; an item's photo on the offer
 *   - the stored path is product-photos/{companyId}/{id}/{sha}.webp, written WebP
 *     and private (no public cache header); a replaced or removed file is deleted
 *   - refused: not a data: image, over 3 MB, a file the re-encode can not read, an
 *     unknown target, an unknown item, a product the company deleted
 *   - an audit row for each save and each removal
 *
 * Run: node tests/price-ledger-photos-2026-11.test.js
 */
'use strict';

const path = require('path');
const Module = require('module');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

const ROOT = path.join(__dirname, '..');
let W;
const clone = (v) => JSON.parse(JSON.stringify(v));
const FieldValue = { serverTimestamp: () => ({ __fv: 'ts' }), delete: () => ({ __fv: 'delete' }) };
const Timestamp = { fromMillis: (ms) => ({ toMillis: () => ms }) };
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const val = (v) => (v && v.__fv === 'ts' ? { ts: ++W.clock } : v);
function docRef(p) {
  return {
    id: p.split('/').pop(), path: p,
    get: async () => { const d = W.docs[p]; return { exists: d != null, id: p.split('/').pop(), ref: docRef(p), data: () => (d == null ? undefined : clone(d)) }; },
    create: async (v) => { if (W.docs[p]) { const e = new Error('exists'); e.code = 6; throw e; } W.docs[p] = clone(v); },
    set: async (v, o) => {
      if (o && o.mergeFields) { const cur = Object.assign({}, W.docs[p] || {}); o.mergeFields.forEach((k) => { if (k in v) cur[k] = val(v[k]); }); W.docs[p] = cur; }
      else W.docs[p] = clone(v);
    },
    update: async (v) => { if (!W.docs[p]) throw new Error('5 NOT_FOUND'); const d = clone(W.docs[p]); Object.keys(v).forEach((k) => { d[k] = val(v[k]); }); W.docs[p] = d; },
  };
}
const DB = { doc: docRef, collection: (n) => ({ doc: (id) => docRef(n + '/' + (id || 'auto' + (++W.seq))) }) };
const bucket = {
  file: (p) => ({
    save: async (b, opts) => { W.files[p] = { bytes: b.length, opts }; },
    delete: async () => { W.deleted.push(p); delete W.files[p]; },
  }),
};
const REENCODE = path.join(ROOT, 'functions', 'photo-reencode.js');
const STUBS = {
  'firebase-functions/v2/https': { HttpsError },
  'firebase-admin/firestore': { FieldValue, Timestamp },
  'firebase-admin/storage': { getStorage: () => ({ bucket: () => bucket }) },
  sharp: () => ({ metadata: async () => ({ width: 640, height: 480 }) }),
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
  if (request === './photo-reencode') {
    let resolved = null; try { resolved = Module._resolveFilename(request, parent, isMain); } catch (_) { /* fall through */ }
    if (resolved === REENCODE) return { reencodePhoto: async (b, fmt, opts) => { W.reencodes.push({ fmt, opts }); if (W.badImage) throw new Error('not an image'); return Buffer.from('webp:' + b.toString('base64').slice(0, 12) + ':' + W.reencodes.length); } };
  }
  return realLoad.apply(this, arguments);
};
const Store = require(path.join(ROOT, 'functions', 'price-ledger-store.js'));

const CO = 'co-a', B = 'priceBook/co-a/';
const CALLER = { uid: 'u_owner', role: 'owner' };
const PNG = 'data:image/png;base64,' + Buffer.from('TEST-not-really-a-png').toString('base64');
function world() {
  W = { docs: {}, files: {}, deleted: [], reencodes: [], clock: 1000, seq: 0, badImage: false };
  W.docs[B + 'priceOffers/off_1'] = { supplierId: 'other_testco', sku: 'TEST-0001', title: 'Testco item', photo: null };
  W.docs[B + 'productLinks/shingle_001'] = { productId: 'shingle_001', applied: { good: { atMs: 1, dollars: 11.11, auditId: 'a_1', undo: false } } };
}
const save = (data) => Store.saveOps.savePhoto(DB, CO, data, CALLER, 1700000000000);
const audits = () => Object.keys(W.docs).filter((p) => p.indexOf(B + 'priceAudit/') === 0).map((p) => W.docs[p]);

(async () => {
  console.log('\nA product photo');
  {
    world();
    const r = await save({ target: 'product', id: 'shingle_001', image: PNG });
    const link = W.docs[B + 'productLinks/shingle_001'];
    const p = link && link.photo && link.photo.path;
    ok('saved on productLinks/{id}.photo with its size and who added it', r.ok === true && p && link.photo.w === 640 && link.photo.h === 480 && link.photo.by === 'u_owner', link);
    ok('the path is product-photos/{companyId}/{id}/{sha}.webp', /^product-photos\/co-a\/shingle_001\/[0-9a-f]{32}\.webp$/.test(p), p);
    ok('the file is re-encoded to WebP at most 640 px and stored private', W.reencodes[0].fmt === 'webp' && W.reencodes[0].opts.maxEdge === 640 && W.files[p] && W.files[p].opts.contentType === 'image/webp' && /private/.test(W.files[p].opts.metadata.cacheControl) && W.files[p].opts.resumable === false);
    ok('the approval markers on the same doc are kept', link.applied && link.applied.good && link.applied.good.dollars === 11.11);
    ok('nothing is written on a product row or the cost book', !Object.keys(W.docs).some((k) => /^productLibrary\/|^catalogCosts\//.test(k)));
    ok('an audit row photo_saved', audits().some((a) => a.type === 'photo_saved' && a.targetType === 'product' && a.targetId === 'shingle_001'));

    const again = await save({ target: 'product', id: 'shingle_001', image: 'data:image/jpeg;base64,' + Buffer.from('TEST-second').toString('base64') });
    const p2 = W.docs[B + 'productLinks/shingle_001'].photo.path;
    ok('a new photo replaces it and the old file is deleted', again.ok && p2 !== p && W.deleted.indexOf(p) !== -1 && W.files[p2]);
    const rm = await save({ target: 'product', id: 'shingle_001', remove: true });
    ok('remove clears the photo, deletes the file and is audited', rm.ok && W.docs[B + 'productLinks/shingle_001'].photo === null && W.deleted.indexOf(p2) !== -1 && audits().some((a) => a.type === 'photo_removed'));
  }
  {
    world();
    delete W.docs[B + 'productLinks/shingle_001'];
    const r = await save({ target: 'product', id: 'shingle_001', image: PNG });
    ok('a product with no link doc yet gets one, with the photo only', r.ok && W.docs[B + 'productLinks/shingle_001'].productId === 'shingle_001' && W.docs[B + 'productLinks/shingle_001'].photo.path && !('applied' in W.docs[B + 'productLinks/shingle_001']));
  }

  console.log('\nAn item photo');
  {
    world();
    const r = await save({ target: 'offer', id: 'off_1', image: PNG });
    const o = W.docs[B + 'priceOffers/off_1'];
    ok('saved on the offer, path under the offer id', r.ok && /^product-photos\/co-a\/off_1\/[0-9a-f]{32}\.webp$/.test(o.photo.path) && o.updatedBy === 'u_owner', o.photo);
    ok('the item\'s other fields are untouched', o.sku === 'TEST-0001' && o.title === 'Testco item');
  }

  console.log('\nRefusals');
  {
    const cases = [
      ['a target that is not product or offer', { target: 'lead', id: 'x', image: PNG }, 'bad_photo_target'],
      ['an item that does not exist', { target: 'offer', id: 'nope', image: PNG }, 'not_found'],
      ['a product id with a slash', { target: 'product', id: '../x', image: PNG }, 'not_found'],
      ['a product nobody has (not in the library, not in the catalog)', { target: 'product', id: 'no_such_product', image: PNG }, 'bad_product'],
      ['not a data: image (an SVG)', { target: 'product', id: 'shingle_001', image: 'data:image/svg+xml;base64,PHN2Zz4=' }, 'photo_bad'],
      ['not a data: URL at all', { target: 'product', id: 'shingle_001', image: 'https://example.com/a.png' }, 'photo_bad'],
      ['over 3 MB', { target: 'product', id: 'shingle_001', image: 'data:image/png;base64,' + Buffer.alloc(3 * 1024 * 1024 + 10, 1).toString('base64') }, 'photo_too_big'],
    ];
    for (const [label, data, reason] of cases) {
      world();
      const before = clone(W.docs);
      const r = await save(data);
      ok(label + ': ' + reason + ', nothing written', r.ok === false && r.reason === reason && Object.keys(W.files).length === 0 && JSON.stringify(W.docs) === JSON.stringify(before), r);
    }
    world();
    W.badImage = true;
    const r = await save({ target: 'product', id: 'shingle_001', image: PNG });
    ok('a file the re-encode can not read: photo_bad, nothing stored', r.ok === false && r.reason === 'photo_bad' && Object.keys(W.files).length === 0);
    world();
    W.docs['productLibrary/' + CO] = { items: {}, deleted: ['shingle_001'] };
    ok('a product the company deleted: bad_product', (await save({ target: 'product', id: 'shingle_001', image: PNG })).reason === 'bad_product');
  }

  console.log('\nEstimate codes on productLinks (2026-11-18, same doc as the photo)');
  {
    world();
    const codes = (data) => Store.saveOps.setEstimateCodes(DB, CO, data, CALLER, 1700000000000);
    const r = await codes({ productId: 'shingle_001', codes: [' rfg 240-gaf-hdz', 'RFG 240-GAF-UHD'] });
    const link = W.docs[B + 'productLinks/shingle_001'];
    ok('a product\'s codes are saved on its link doc, cleaned, and marked as the company\'s own list', r.ok && link.estimateCodes.join('|') === 'RFG 240-GAF-HDZ|RFG 240-GAF-UHD' && link.estimateCodesSet === true, link);
    ok('the approval markers and photo on that doc are kept', link.applied && link.applied.good && link.applied.good.dollars === 11.11);
    ok('an audit row estimate_codes_set', audits().some((a) => a.type === 'estimate_codes_set' && a.targetId === 'shingle_001'));
    const back = await codes({ productId: 'shingle_001', reset: true });
    ok('reset goes back to the starter list (estimateCodesSet false, no codes)', back.ok && W.docs[B + 'productLinks/shingle_001'].estimateCodesSet === false && W.docs[B + 'productLinks/shingle_001'].estimateCodes.length === 0);
    const before = JSON.stringify(W.docs);
    ok('a bad code list is refused, nothing written', (await codes({ productId: 'shingle_001', codes: ['<b>x</b>'] })).reason === 'bad_codes' && JSON.stringify(W.docs) === before);
    ok('a product nobody has is refused', (await codes({ productId: 'no_such_product', codes: [] })).reason === 'bad_product');
  }

  console.log('\nCode ratios on productLinks (2026-11-18)');
  {
    world();
    const ratio = (data) => Store.saveOps.setCodeRatio(DB, CO, data, CALLER, 1700000000000);
    const r = await ratio({ productId: 'shingle_001', code: ' rfg 240-gaf-hdz ', num: 20, den: 2 });
    const link = W.docs[B + 'productLinks/shingle_001'];
    ok('a ratio is saved on the link, code cleaned, fraction reduced; the approval markers are kept', r.ok && link.codeRatios['RFG 240-GAF-HDZ'].num === 10 && link.codeRatios['RFG 240-GAF-HDZ'].den === 1 && link.applied.good.dollars === 11.11, link);
    await ratio({ productId: 'shingle_001', code: 'RFG 3T20', num: 3, den: 1 });
    ok('a second code adds to the map', Object.keys(W.docs[B + 'productLinks/shingle_001'].codeRatios).length === 2);
    const c = await ratio({ productId: 'shingle_001', code: 'RFG 240-GAF-HDZ', clear: true });
    ok('clear removes one code\'s ratio only', c.ok && !('RFG 240-GAF-HDZ' in W.docs[B + 'productLinks/shingle_001'].codeRatios) && W.docs[B + 'productLinks/shingle_001'].codeRatios['RFG 3T20'].num === 3);
    ok('audited as code_ratio_set', audits().filter((a) => a.type === 'code_ratio_set').length === 3);
    const before = JSON.stringify(W.docs);
    ok('a zero or broken ratio is refused, nothing written', (await ratio({ productId: 'shingle_001', code: 'RFG 15F', num: 0, den: 1 })).reason === 'bad_ratio' && (await ratio({ productId: 'shingle_001', code: '<x>', num: 1, den: 1 })).reason === 'bad_ratio' && JSON.stringify(W.docs) === before);
  }

  console.log('\nPhotos stay inside the CRM');
  {
    const fs = require('fs');
    const hits = [];
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (p !== path.join(ROOT, 'docs', 'pro')) walk(p); }
      else if (/\.(html|js|txt|json|xml)$/.test(e.name) && fs.readFileSync(p, 'utf8').indexOf('product-photos/') !== -1) hits.push(path.relative(ROOT, p));
    });
    walk(path.join(ROOT, 'docs'));
    ['render-pdf.js', 'customer-estimate-rows.js', 'portal.js'].forEach((f) => {
      const p = path.join(ROOT, 'functions', f);
      if (fs.existsSync(p) && fs.readFileSync(p, 'utf8').indexOf('product-photos/') !== -1) hits.push('functions/' + f);
    });
    fs.readdirSync(path.join(ROOT, 'docs', 'pro', 'js')).filter((f) => /^document-generator/.test(f)).forEach((f) => {
      if (fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', f), 'utf8').indexOf('product-photos/') !== -1) hits.push('docs/pro/js/' + f);
    });
    ok('no public page and no customer-document file names the product-photos/ path', hits.length === 0, hits);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
