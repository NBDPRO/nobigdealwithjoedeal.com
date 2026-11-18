/**
 * tests/sign-price-snapshot-2026-11-14.test.js
 *
 * A remote (HTML) contract bills the price the homeowner SAW, not the
 * estimate's price at the moment they sign (money review 2026-11-14,
 * finding 8).
 *
 * THE BUG: createSignRequest stored no price on doc_sign_tokens. When the
 * homeowner signed, the job spine's contract_signed stamped
 * estimates/{primary}.signedPrice from the estimate "as it stands"
 * (signed-price.js). Rep sends a $14,500 contract, edits the estimate to
 * $16,200 while the link is out, homeowner signs the $14,500 page — and the
 * deposit draft, invoices and portal bill $16,200. The e-sign envelope path
 * already snapshots its price at send (esign-envelope.js pricedSnapshot);
 * this path did not.
 *
 * THE FIX: createSignRequest stamps the primary estimate's priced fields on
 * the (admin-only) token; submitSignature hands them to the spine; the stamp
 * uses them. If the estimate moved since the link was sent, the snapshot
 * wins and the stamp records movedSinceSent + the current total, and the
 * rep's "Document signed" bell says so.
 *
 * Real code end to end: remote-signing.js createSignRequest / submitSignature,
 * job-spine.js spineAfterRemoteSign → recordJobEvent → signed-price.js
 * stampSignedPrice, on fake Firestore + Storage. Nothing is sent (Resend is a
 * stub; no network).
 *
 * Run: node tests/sign-price-snapshot-2026-11-14.test.js   (needs functions/node_modules)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const c = (n) => Math.round(Number(n) * 100);

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}
// The Cloud Functions logger prints structured JSON lines; keep them out.
for (const m of ['log', 'info', 'warn', 'error']) {
  const orig = console[m].bind(console);
  console[m] = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{') && a[0].includes('"severity"')) return; orig(...a); };
}

const CER = require(path.join(FN, 'customer-estimate-rows.js'));
const SP = require(path.join(FN, 'signed-price.js'));
const SPINE = require(path.join(FN, 'job-spine.js'));

// ── fixtures (signed-price-r6-2026-10-07.test.js's worked example) ──────
// NBD's own tenant (as signed-price-r6): its cash deposit rule applies
// without a companyProfile, so a deposit draft is made at signing.
const U = '1phDvAVXHSg82wDLegAbQFq14Ci1';
const NOW = Date.now();
const OH = '12 Main St, Milford, OH 45150';
const lead0 = () => ({ userId: U, companyId: U, primaryEstimateId: 'E1', address: OH, state: 'OH', firstName: 'Pat', lastName: 'Lee', email: 'pat@example.test', jobType: 'cash', stage: 'estimate_sent' });
const est14500 = () => ({ userId: U, companyId: U, leadId: 'L1', grandTotal: 14500, subtotal: 14500, tax: 0, taxRate: 0, mode: 'cash', addr: OH, createdAt: 1,
  rows: [{ desc: 'Roof', qty: '1', retailTotal: 14500, total: 14500 }] });
const reprice = (e) => Object.assign({}, e, { grandTotal: 16200, subtotal: 16200,
  rows: e.rows.concat([{ desc: 'Upgrade', qty: '1', retailTotal: 1700, total: 1700 }]) });

// ── fake transactional Firestore (from signed-price-r6-2026-10-07.test.js) ──
function makeDb(seed) {
  const clone = (d) => (d === undefined ? undefined : JSON.parse(JSON.stringify(d)));
  const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, clone(v)]));
  const isSentinel = (v) => v && typeof v === 'object' && (v.__ts || v.__union || v.__inc != null || v.__del);
  const apply = (cur, patch) => {
    const d = Object.assign({}, cur);
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      const keys = k.split('.');
      let o = d;
      for (let i = 0; i < keys.length - 1; i++) { o[keys[i]] = Object.assign({}, o[keys[i]] || {}); o = o[keys[i]]; }
      const last = keys[keys.length - 1];
      if (v && v.__union) o[last] = (Array.isArray(o[last]) ? o[last] : []).concat(v.__union);
      else if (v && v.__inc != null) o[last] = (Number(o[last]) || 0) + v.__inc;
      else if (v && v.__del) delete o[last];
      else if (v && v.__ts) o[last] = NOW;
      else o[last] = isSentinel(v) ? null : clone(v);
    }
    return d;
  };
  let seq = 0;
  const ref = (p) => ({
    path: p, id: p.split('/').pop(),
    collection: (cn) => col(p + '/' + cn),
    async get() { const d = store.get(p); return { exists: d !== undefined, id: p.split('/').pop(), data: () => clone(d) }; },
    async update(patch) { if (!store.has(p)) throw new Error('NOT_FOUND ' + p); store.set(p, apply(store.get(p), patch)); },
    async set(data, opt) { store.set(p, opt && (opt.merge || opt.mergeFields) ? apply(store.get(p) || {}, data) : apply({}, data)); },
    async create(data) { if (store.has(p)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } store.set(p, apply({}, data)); },
  });
  const query = (cn, filters, lim) => ({
    where: (f, op, v) => query(cn, filters.concat([[f, op, v]]), lim),
    limit: (n) => query(cn, filters, n),
    orderBy: () => query(cn, filters, lim),
    async get() {
      const docs = [];
      for (const [k, v] of store) {
        const parts = k.split('/');
        if (parts.length !== cn.split('/').length + 1 || !k.startsWith(cn + '/')) continue;
        if (filters.every(([f, op, val]) => (op === 'in' ? val.indexOf(v[f]) !== -1 : v[f] === val))) docs.push({ id: parts[parts.length - 1], data: () => clone(v) });
      }
      const out = docs.slice(0, lim || docs.length);
      return { docs: out, empty: !out.length, size: out.length, forEach: (f) => out.forEach(f) };
    },
  });
  const col = (cn) => Object.assign({ doc: (id) => ref(cn + '/' + (id || ('auto' + (++seq)))), async add(d) { const r = ref(cn + '/auto' + (++seq)); await r.set(d); return r; } }, query(cn, [], 0));
  return {
    store, collection: col, doc: (p) => ref(p),
    async runTransaction(fn) {
      const pending = [];
      const tx = {
        get: (r) => r.get(),
        create: (r, d) => pending.push(() => r.create(d)),
        set: (r, d, opt) => pending.push(() => r.set(d, opt)),
        update: (r, p) => pending.push(() => r.update(p)),
      };
      const out = await fn(tx);
      for (const f of pending) await f();
      return out;
    },
  };
}
const FV = { serverTimestamp: () => ({ __ts: true }), arrayUnion: (...x) => ({ __union: x }), increment: (n) => ({ __inc: n }), delete: () => ({ __del: true }) };
const quiet = { info() {}, warn() {}, error() {} };
const spineDeps = { FieldValue: FV, logger: quiet, now: () => NOW };

function makeStorage(files) {
  const m = new Map(Object.entries(files || {}).map(([k, v]) => [k, Buffer.from(v, 'utf8')]));
  return {
    bucket: () => ({ file: (p) => ({
      download: async () => { if (!m.has(p)) throw new Error('no such object ' + p); return [m.get(p)]; },
      save: async (buf) => { m.set(p, Buffer.from(buf)); },
      getMetadata: async () => [{ size: (m.get(p) || Buffer.alloc(0)).length }],
      getSignedUrl: async () => ['https://signed.example.test/' + p],
    }) }),
    _files: m,
  };
}

// remote-signing.js with real module code and fake I/O (the loader from
// tests/contract-cancel-forms.test.js); its job-spine hand-off is the REAL
// spine on the same fake Firestore.
const REAL = ['./ky-insurance-law', './cancel-window', './cancel-notice-pdf', './job-spine-logic', './lead-artifact-paths', './esign-logic', './doc-evidence',
  './await-briefly', './customer-estimate-rows', './signed-price', 'crypto'];
function loadRemoteSigning(db, storage, spy) {
  const file = path.join(FN, 'remote-signing.js');
  class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
  const stubs = {
    './messaging-controls': require('./lib/messaging-controls-stub'),
    'firebase-functions/v2/https': { onCall: (o, h) => h, onRequest: (o, h) => h, HttpsError },
    'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'stub' }) },
    'firebase-functions/v2': { logger: quiet },
    'firebase-admin/firestore': { getFirestore: () => db, Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) }, FieldValue: FV },
    'firebase-admin/storage': { getStorage: () => storage },
    './integrations/upstash-ratelimit': { httpRateLimit: async () => true, clientIp: () => '203.0.113.9' },
    './shared': { callableRateLimit: async () => {}, assertNotViewer: () => {} },
    './estimate-view-alert': { recordEstimateView: async () => {} },
    './integrations/_shared': { secretOr: (_s, d) => d },
    './resend-guard': { resendRejected: () => false, resendErrorMessage: () => '' },
    './job-spine': {
      spineAfterRemoteSign: async (d, info) => { spy.push(info); return SPINE.spineAfterRemoteSign(d, info, spineDeps); },
      spineAfterDealAccept: async () => ({}), spineAfterEsign: async () => ({}),
    },
    resend: { Resend: class { constructor() { this.emails = { send: async () => ({ data: { id: 'm1' } }) }; } } },
  };
  const req = (id) => {
    if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
    if (REAL.indexOf(id) !== -1) return require(id.charAt(0) === '.' ? path.join(FN, id) : id);
    throw new Error('unstubbed require(' + id + ')');
  };
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', 'console', 'process', fs.readFileSync(file, 'utf8'))(mod, mod.exports, req, { log() {}, warn() {}, error() {} }, process);
  return mod.exports;
}
function reqRes(body) {
  const res = { statusCode: 200, body: null, headers: {},
    status(x) { this.statusCode = x; return this; }, json(b) { this.body = b; return this; }, set(k, v) { this.headers[k] = v; return this; },
    send(b) { this.body = b; return this; }, end() { return this; } };
  return { req: { method: 'POST', body, get: () => 'Mozilla/5.0 (iPhone)', path: '', headers: {}, ip: '203.0.113.9' }, res };
}

// A contract page: the price it prints, the FTC packet (two completed forms),
// one homeowner signature block.
const HTML_PATH = 'documents/' + U + '/L1/d1.html';
const CONTRACT = '<!DOCTYPE html><html><head><title>Roofing Contract</title></head><body>'
  + '<h1>Roofing Contract</h1><p>Contract price: $14,500.00</p>'
  + '<!--nbd-cancel-packet:start--><section data-nbd-cancel-by="2026-11-17"><h2>Notice of Right to Cancel</h2>'
  + '<div data-nbd-noc="ftc"><p>NOTICE OF CANCELLATION. NOT LATER THAN MIDNIGHT OF November 17, 2026</p></div>'
  + '<div data-nbd-noc="ftc"><p>NOTICE OF CANCELLATION. NOT LATER THAN MIDNIGHT OF November 17, 2026</p></div>'
  + '</section><!--nbd-cancel-packet:end-->'
  + '<div data-nbd-sig="homeowner" data-nbd-sig-required="1"><canvas width="300" height="100"></canvas></div>'
  + '</body></html>';
const SIG_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const signIt = (html) => html
  .replace(/<canvas\b[^>]*>\s*<\/canvas>/, '<img src="' + SIG_PNG + '" class="nbd-sig-img">')
  .replace(/data-nbd-sig="homeowner"/, 'data-nbd-sig="homeowner" data-nbd-sig-finalized="1"');

function world(extra) {
  return Object.assign({
    'leads/L1': lead0(),
    'leads/L1/documents/d1': { type: 'contract', typeName: 'Roofing Contract', htmlPath: HTML_PATH, userId: U },
    'estimates/E1': est14500(),
  }, extra || {});
}

async function sendThenSign(db, { editBeforeSign, dropSnapshot } = {}) {
  const st = makeStorage({ [HTML_PATH]: CONTRACT });
  const spy = [];
  const fns = loadRemoteSigning(db, st, spy);
  let sent;
  try { sent = await fns.createSignRequest({ auth: { uid: U, token: {} }, data: { leadId: 'L1', docId: 'd1', signerEmail: 'pat@example.test' } }); }
  catch (e) { return { err: 'createSignRequest: ' + e.message }; }
  const tokKey = 'doc_sign_tokens/' + sent.token;
  if (dropSnapshot) { const t = db.store.get(tokKey); Object.keys(t).forEach((k) => { if (/price/i.test(k)) delete t[k]; }); }
  const token = db.store.get(tokKey);
  if (editBeforeSign) db.store.set('estimates/E1', reprice(db.store.get('estimates/E1')));
  const s = reqRes({ token: sent.token, signedHtml: signIt(CONTRACT) });
  await fns.submitSignature(s.req, s.res);
  return { token, res: s.res, spy, est: db.store.get('estimates/E1'), db };
}

// Step-by-step helpers for the multi-link scenarios (review round, 2026-11-14).
const HTML_PATH_2 = 'documents/' + U + '/L1/d2.html';
function rig(db) {
  const st = makeStorage({ [HTML_PATH]: CONTRACT, [HTML_PATH_2]: CONTRACT.replace('Roofing Contract</h1>', 'Roofing Contract (revised)</h1>') });
  const fns = loadRemoteSigning(db, st, []);
  return {
    fns,
    async mint(docId) {
      try { return await fns.createSignRequest({ auth: { uid: U, token: {} }, data: { leadId: 'L1', docId, signerEmail: 'pat@example.test' } }); }
      catch (e) { return { err: e.message }; }
    },
    async sign(token, docId, extraBody) {
      const html = docId === 'd2' ? CONTRACT.replace('Roofing Contract</h1>', 'Roofing Contract (revised)</h1>') : CONTRACT;
      const s = reqRes(Object.assign({ token, signedHtml: signIt(html) }, extraBody || {}));
      await fns.submitSignature(s.req, s.res);
      return s.res;
    },
  };
}
const notes = (db, type) => [...db.store.entries()].filter(([k, v]) => k.startsWith('notifications/') && (!type || v.type === type)).map(([, v]) => v);
const activity = (db, type) => [...db.store.entries()].filter(([k, v]) => k.startsWith('leads/L1/activity/') && (!type || v.type === type)).map(([, v]) => v);

(async () => {
  // ════════════════════════════════════════════════════════════════════
  console.log('\n1. Sent at $14,500, edited to $16,200 while the link was out, then signed');
  // ════════════════════════════════════════════════════════════════════
  {
    const db = makeDb(world());
    const r = await sendThenSign(db, { editBeforeSign: true });
    ok('the remote signing round trip runs (createSignRequest → submitSignature 200)', !r.err && r.res.statusCode === 200, r.err || JSON.stringify(r.res.body));
    if (!r.err) {
      const snap = r.token && r.token.priceSnapshot;
      ok('the sign request carries a price snapshot of the primary estimate at send: $14,500',
        !!snap && snap.estimateId === 'E1' && snap.totalCents === 1450000 && snap.fields && c(snap.fields.grandTotal) === 1450000, JSON.stringify(snap));
      const sp = r.est.signedPrice;
      ok('the signed price is the $14,500 the homeowner saw — not the $16,200 the estimate says now',
        !!sp && sp.totalCents === 1450000 && c(CER.signedView(r.est).grandTotal) === 1450000, JSON.stringify(sp && { t: sp.totalCents, from: sp.from }));
      ok('…stamped from the sign request', sp && sp.from === 'sign_request', sp && sp.from);
      ok('…and flagged for the rep: movedSinceSent with the estimate\'s current $16,200',
        sp && sp.movedSinceSent === true && sp.currentTotalCents === 1620000, JSON.stringify(sp && { m: sp.movedSinceSent, cur: sp.currentTotalCents }));
      ok('the CRM\'s "unsigned changes" chip lights (estimate ≠ what was signed)', CER.hasUnsignedChanges(r.est) === true);
      const draft = [...db.store.entries()].find(([k]) => k.startsWith('invoices/depdraft_'));
      ok('the deposit draft bills the signed $14,500 (not $16,200)', !!draft && c(draft[1].total) === 1450000, draft ? String(draft[1].total) : 'no draft');
      const bell = [...db.store.entries()].find(([k, v]) => k.startsWith('notifications/') && v.type === 'remote_signature');
      ok('the rep\'s "Document signed" bell names both prices',
        !!bell && /\$14,500/.test(bell[1].message) && /\$16,200/.test(bell[1].message), bell && bell[1].message);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\n2. Controls');
  // ════════════════════════════════════════════════════════════════════
  {
    const db = makeDb(world());
    const r = await sendThenSign(db, {});
    const sp = r.est && r.est.signedPrice;
    ok('estimate unchanged: stamped $14,500 from the sign request, no flag', !r.err && sp && sp.totalCents === 1450000 && sp.from === 'sign_request' && !sp.movedSinceSent,
      r.err || JSON.stringify(sp));
    const bell = [...db.store.entries()].find(([k, v]) => k.startsWith('notifications/') && v.type === 'remote_signature');
    ok('…and the bell reads as before', !!bell && bell[1].message === 'Pat Lee signed a document remotely.', bell && bell[1].message);

    // A link minted before this shipped carries no snapshot: unchanged behaviour.
    const db2 = makeDb(world());
    const r2 = await sendThenSign(db2, { editBeforeSign: true, dropSnapshot: true });
    const sp2 = r2.est && r2.est.signedPrice;
    ok('a legacy link with no snapshot stamps the estimate as it stands (as before)', !r2.err && sp2 && sp2.totalCents === 1620000 && sp2.from === 'estimate',
      r2.err || JSON.stringify(sp2 && { t: sp2.totalCents, from: sp2.from }));

    // Pure decision: a snapshot for another estimate is never used.
    const lead = Object.assign({ id: 'L1' }, lead0());
    const snapE9 = { estimateId: 'E9', fields: CER.signedPriceSnapshot(est14500()) };
    const p = SP.planSignedStamp({ leadId: 'L1', lead, est: reprice(est14500()), estimateId: 'E1', event: 'contract_signed', sourceId: 'doc_x', signRequest: snapE9, nowMs: NOW });
    ok('planSignedStamp ignores a snapshot taken from a different estimate', p.action === 'stamp' && p.signedPrice.totalCents === 1620000 && p.signedPrice.from === 'estimate', JSON.stringify(p.signedPrice && { t: p.signedPrice.totalCents, from: p.signedPrice.from }));
    const snapOk = { estimateId: 'E1', fields: CER.signedPriceSnapshot(est14500()) };
    const p2 = SP.planSignedStamp({ leadId: 'L1', lead, est: reprice(est14500()), estimateId: 'E1', event: 'contract_signed', sourceId: 'doc_y', signRequest: snapOk, nowMs: NOW });
    ok('planSignedStamp uses a snapshot of this estimate', p2.action === 'stamp' && p2.signedPrice.totalCents === 1450000 && p2.signedPrice.from === 'sign_request');
    ok('signedEstimateIdFor: the sign request\'s estimate beats the lead\'s primary',
      SP.signedEstimateIdFor({ primaryEstimateId: 'E1' }, null, null, { estimateId: 'E2' }) === 'E2');
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\n3. T1 — an older link signed after a newer one never lowers the signed price (H1)');
  // ════════════════════════════════════════════════════════════════════
  {
    const db = makeDb(world({ 'leads/L1/documents/d2': { type: 'contract', typeName: 'Roofing Contract', htmlPath: HTML_PATH_2, userId: U } }));
    const R = rig(db);
    const a = await R.mint('d1');                                   // link A at $14,500
    db.store.set('estimates/E1', reprice(db.store.get('estimates/E1'))); // re-priced to $16,200
    const b = await R.mint('d2');                                   // contract d2 / link B at $16,200
    ok('both links mint', !a.err && !b.err, a.err || b.err);
    ok('minting B supersedes the older pending contract link A', db.store.get('doc_sign_tokens/' + a.token).status === 'superseded',
      db.store.get('doc_sign_tokens/' + a.token).status);
    const rb = await R.sign(b.token, 'd2');
    ok('the homeowner signs B → 200, stamped $16,200', rb.statusCode === 200 && db.store.get('estimates/E1').signedPrice.totalCents === 1620000,
      rb.statusCode + ' ' + JSON.stringify(db.store.get('estimates/E1').signedPrice && db.store.get('estimates/E1').signedPrice.totalCents));
    const ra = await R.sign(a.token, 'd1');
    ok('…then signs the older link A → refused (410, replaced by a newer link)', ra.statusCode === 410 && /newer/i.test((ra.body && ra.body.error) || ''), ra.statusCode + ' ' + JSON.stringify(ra.body));
    ok('signedPrice stays $16,200 (1620000)', db.store.get('estimates/E1').signedPrice.totalCents === 1620000, String(db.store.get('estimates/E1').signedPrice.totalCents));

    // A legacy pending contract link (minted before this shipped, so never
    // superseded at mint) is retired when a contract_signed stamps.
    const db2 = makeDb(world({
      'leads/L1/documents/d2': { type: 'contract', typeName: 'Roofing Contract', htmlPath: HTML_PATH_2, userId: U },
      'doc_sign_tokens/LEGACYTOKEN0000000001': { leadId: 'L1', docId: 'd2', ownerUid: U, htmlPath: HTML_PATH_2, status: 'pending', signerName: 'Pat Lee' },
    }));
    const R2 = rig(db2);
    db2.store.get('doc_sign_tokens/LEGACYTOKEN0000000001').status = 'pending';
    const c1 = await R2.mint('d1');
    await R2.sign(c1.token, 'd1');
    ok('a new contract link or a contract signing retires the lead\'s other pending contract links (a legacy token with no docType too)', db2.store.get('doc_sign_tokens/LEGACYTOKEN0000000001').status === 'superseded',
      db2.store.get('doc_sign_tokens/LEGACYTOKEN0000000001').status);

    // The pure guard (a race the supersede cannot close): a snapshot minted
    // before the current stamp's offer never overwrites it.
    const lead = Object.assign({ id: 'L1' }, lead0());
    const newer = { fields: CER.signedPriceSnapshot(reprice(est14500())), fingerprint: 'p1-n', totalCents: 1620000, source: 'contract_signed', sourceId: 'doc_d2', from: 'sign_request', mintedAtMs: NOW - 1000, at: NOW };
    const older = { estimateId: 'E1', fields: CER.signedPriceSnapshot(est14500()), mintedAtMs: NOW - 5000 };
    const p = SP.planSignedStamp({ leadId: 'L1', lead, est: Object.assign(reprice(est14500()), { signedPrice: newer }), estimateId: 'E1', event: 'contract_signed', sourceId: 'doc_d1', signRequest: older, nowMs: NOW });
    ok('planSignedStamp: an older link\'s snapshot → skip older_than_current', p.action === 'skip' && p.reason === 'older_than_current', JSON.stringify(p));
    const later = { estimateId: 'E1', fields: CER.signedPriceSnapshot(est14500()), mintedAtMs: NOW + 5000 };
    const p2 = SP.planSignedStamp({ leadId: 'L1', lead, est: Object.assign(reprice(est14500()), { signedPrice: newer }), estimateId: 'E1', event: 'contract_signed', sourceId: 'doc_d3', signRequest: later, nowMs: NOW + 6000 });
    ok('…a link minted AFTER the current stamp (a real re-sign) still stamps', p2.action === 'stamp' && p2.signedPrice.mintedAtMs === NOW + 5000);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\n4. T8 — a homeowner-supplied priceSnapshot in the submit body is ignored');
  // ════════════════════════════════════════════════════════════════════
  {
    const db = makeDb(world());
    const R = rig(db);
    const a = await R.mint('d1');
    const forged = { estimateId: 'E1', fields: { grandTotal: 1, total: 1 }, totalCents: 100, mintedAtMs: NOW + 99999 };
    const r = await R.sign(a.token, 'd1', { priceSnapshot: forged, signRequestPrice: forged, meta: { signRequestPrice: forged } });
    ok('signed at the token\'s $14,500, not the body\'s $0.01', r.statusCode === 200 && db.store.get('estimates/E1').signedPrice.totalCents === 1450000,
      r.statusCode + ' ' + JSON.stringify(db.store.get('estimates/E1').signedPrice && db.store.get('estimates/E1').signedPrice.totalCents));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\n5. A link that goes out without a locked price says so (silent-failure review)');
  // ════════════════════════════════════════════════════════════════════
  {
    const db = makeDb(world({ 'leads/L1': Object.assign(lead0(), { primaryEstimateId: null }) }));
    const R = rig(db);
    const a = await R.mint('d1');
    ok('createSignRequest returns priceLocked:false + a reason when there is no snapshot', a.priceLocked === false && a.priceLockReason === 'no_primary_estimate', JSON.stringify(a));
    ok('…and stamps priceSnapshotMissing on the token', db.store.get('doc_sign_tokens/' + a.token).priceSnapshotMissing === true);
    await R.sign(a.token, 'd1');
    const bell = notes(db, 'remote_signature')[0];
    ok('at signing the rep\'s bell says the price was not locked', !!bell && /price was not locked/i.test(bell.message), bell && bell.message);

    const ok2 = await rig(makeDb(world())).mint('d1');
    ok('a normal contract link returns priceLocked:true', ok2.priceLocked === true, JSON.stringify(ok2));

    // The viewer warns the rep when the link went out unlocked.
    const src = fs.readFileSync(path.join(ROOT, 'docs/pro/js/nbd-doc-viewer.js'), 'utf8').replace(/\r\n/g, '\n');
    const at = src.indexOf('async function handleSendForSignature()');
    const end = at === -1 ? -1 : src.indexOf('\n  }\n', at);
    ok('found handleSendForSignature in nbd-doc-viewer.js', at !== -1 && end !== -1);
    if (at !== -1 && end !== -1) {
      const run = async (resp) => {
        const toasts = [];
        const sb = { window: { prompt: () => 'pat@example.test', showToast: (m, t) => toasts.push([m, t]) }, flashStatus: () => {},
          currentContext: { signerEmailDefault: '', onSendForSignature: async () => resp } };
        await require('vm').runInNewContext('(' + src.slice(at, end + 4).replace(/^async function handleSendForSignature\(\)/, 'async function ()') + ')', sb)();
        return toasts;
      };
      const t1 = await run({ emailed: true, signLink: 'x', priceLocked: false, priceLockReason: 'no_primary_estimate' });
      ok('the viewer shows a warning toast when priceLocked is false', t1.some(([m, t]) => t === 'warning' && /price/i.test(m)), JSON.stringify(t1));
      const t2 = await run({ emailed: true, signLink: 'x', priceLocked: true });
      ok('…and no warning for a locked (or non-contract) link', t2.length === 0, JSON.stringify(t2));
    }
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\n6. A signature whose price could not be locked tells the rep (silent-failure review)');
  // ════════════════════════════════════════════════════════════════════
  {
    // The contract's estimate belongs to another tenant → estimate_other_tenant.
    const db = makeDb(world());
    const R = rig(db);
    const a = await R.mint('d1');
    db.store.set('estimates/E1', Object.assign(db.store.get('estimates/E1'), { userId: 'other', companyId: 'other' }));
    await R.sign(a.token, 'd1');
    const n = notes(db, 'price_not_locked')[0];
    ok('a skipped stamp (estimate_other_tenant) notifies the rep "signed, but the price was not locked"', !!n && n.userId === U && /not locked/i.test(n.title + ' ' + n.message), JSON.stringify(n));
    ok('…and logs it on the lead\'s activity feed', activity(db, 'price_not_locked').length === 1);

    // A throw inside the stamp.
    const dbT = makeDb(world());
    const realTx = dbT.runTransaction;
    dbT.runTransaction = async () => { throw new Error('contention'); };
    const out = await SP.stampSignedPrice(dbT, { leadId: 'L1', event: 'contract_signed', sourceId: 'doc_z', meta: {} }, { logger: quiet, FieldValue: FV });
    dbT.runTransaction = realTx;
    ok('a stamp that throws → reason error, rep notified, estimate flagged', out.reason === 'error' && notes(dbT, 'price_not_locked').length === 1
      && !!(dbT.store.get('estimates/E1').priceLockIssue && dbT.store.get('estimates/E1').priceLockIssue.reason === 'error'), JSON.stringify({ out, e: dbT.store.get('estimates/E1').priceLockIssue }));

    // already_stamped is not an alert.
    const dbS = makeDb(world({ 'estimates/E1': Object.assign(est14500(), { signedPrice: { fields: CER.signedPriceSnapshot(est14500()), totalCents: 1450000, sourceId: 'doc_same', at: NOW } }) }));
    await SP.stampSignedPrice(dbS, { leadId: 'L1', event: 'contract_signed', sourceId: 'doc_same', meta: {} }, { logger: quiet, FieldValue: FV });
    ok('already_stamped → no alert', notes(dbS, 'price_not_locked').length === 0);

    // The moved-price warning also lands on the activity feed (a bell that
    // fails to write is not the only record).
    const dbM = makeDb(world());
    await sendThenSign(dbM, { editBeforeSign: true });
    const m = activity(dbM, 'signed_price_moved')[0];
    ok('movedSinceSent is written to the lead\'s activity feed with both prices', !!m && /\$14,500/.test(m.label) && /\$16,200/.test(m.label), JSON.stringify(m));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e && e.stack); process.exit(1); });
