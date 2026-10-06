/**
 * tests/report-link-pdf-only-2026-10-06.test.js
 *
 * R3-4 (phased review round 3, 2026-10-06; Jo approved the fix the same day).
 * A /report/<token> link for a lead document streamed the Storage object with
 * the object's CURRENT Content-Type and no CSP / nosniff. The type is checked
 * only when the link is minted, and a filed money-paper PDF
 * (documents/{uid}/{leadId}/{id}.pdf) was client-overwritable with text/html,
 * so a rep could plant a script page on nobigdealwithjoedeal.com behind a link
 * that looks like an invoice.
 *
 * The fix, pinned here by DRIVING the real handlers (firebase stubbed at the
 * module loader, the security-batch-2026-10-03 idiom):
 *   A. getSharedReport lead_document branch, on every view:
 *      - an object whose contentType is not application/pdf → 4xx, no bytes;
 *      - an object that claims application/pdf but does not start with %PDF → 4xx;
 *      - a real PDF → 200 with Content-Type: application/pdf (fixed, not the
 *        object's), X-Content-Type-Options: nosniff and a `sandbox` CSP with
 *        default-src 'none'.
 *   B. money-paper files its PDFs with customMetadata signed:'true', so the
 *      existing storage.rules lock (storedObjectIsSigned) refuses client
 *      overwrites. The rules half is in storage-rules.test.js.
 *   C. getDealRoom: the response carries a `sandbox` CSP (with the allow-*
 *      tokens the ACCEPT flow needs) plus nosniff, and the stored HTML loses
 *      every <meta http-equiv> and <base> tag before it is served.
 *
 * Pure Node. Run: node tests/report-link-pdf-only-2026-10-06.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const Module = require('module');
const { PassThrough } = require('stream');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const FUNCTIONS = path.join(__dirname, '..', 'functions');
const TOKEN = 'B'.repeat(32);
const FILED = 'documents/u1/lead-1/inv-1.pdf';

let stubs = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (stubs && Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.apply(this, arguments);
};

// objects: { path: { meta: {...}, body: string } }
function makeStubs(docs, objects) {
  const docRef = (p) => ({
    get: async () => ({ exists: docs[p] != null, data: () => docs[p], get: (k) => (docs[p] || {})[k] }),
    update: async () => {},
    set: async () => {},
  });
  const db = {
    doc: docRef,
    collection: (n) => ({ doc: (id) => docRef(n + '/' + id), where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [], forEach() {} }) }) }) }),
  };
  const noop = () => {};
  const file = (p) => ({
    getMetadata: async () => {
      const o = objects[p];
      if (!o) { const e = new Error('No such object'); e.code = 404; throw e; }
      return [Object.assign({ size: String(o.body.length), generation: '1' }, o.meta)];
    },
    download: async (opts) => {
      const o = objects[p];
      if (!o) { const e = new Error('No such object'); e.code = 404; throw e; }
      const b = Buffer.from(o.body);
      if (opts && typeof opts.start === 'number') return [b.slice(opts.start, (opts.end == null ? b.length - 1 : opts.end) + 1)];
      return [b];
    },
    createReadStream: () => {
      const s = new PassThrough(); const o = objects[p];
      setImmediate(() => s.end(Buffer.from(o ? o.body : '')));
      return s;
    },
  });
  return {
    'firebase-functions/v2/https': {
      onRequest: (o, h) => ({ __handler: h }),
      onCall: (o, h) => ({ __handler: h }),
      HttpsError: class extends Error {},
    },
    'firebase-functions/v2': { logger: { info: noop, warn: noop, error: noop } },
    'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => '' }) },
    'firebase-admin/firestore': {
      getFirestore: () => db,
      FieldValue: { serverTimestamp: () => 'ts', increment: (n) => n },
      Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) },
    },
    'firebase-admin/storage': { getStorage: () => ({ bucket: () => ({ file }) }) },
    './integrations/upstash-ratelimit': { httpRateLimit: async () => true },
    './integrations/_shared': { secretOr: (s, d) => d },
    './shared': { callableRateLimit: async () => {}, assertNotViewer: noop },
    './deal-install-date': { fillLeadInstallDate: async () => {} },
    './push-functions': {},
    './estimate-view-alert': { recordEstimateView: async () => {} },
  };
}

// A response that is also a writable sink, so file.createReadStream().pipe(res)
// collects the bytes exactly as Express would send them.
function mkRes() {
  const r = new PassThrough();
  r.statusCode = 200; r.headers = {}; r.body = undefined; r.chunks = [];
  r.on('data', (c) => r.chunks.push(Buffer.from(c)));
  r.set = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.bytes = () => Buffer.concat(r.chunks).toString('utf8');
  return r;
}

function load(file, docs, objects) {
  stubs = makeStubs(docs, objects);
  delete require.cache[path.join(FUNCTIONS, file)];
  return require(path.join(FUNCTIONS, file));
}

function parseCsp(v) {
  const out = {};
  String(v || '').split(';').map((s) => s.trim()).filter(Boolean).forEach((d) => {
    const [name, ...vals] = d.split(/\s+/);
    out[name.toLowerCase()] = vals;
  });
  return out;
}

const tokDoc = () => ({
  kind: 'lead_document', status: 'active', leadId: 'lead-1', ownerUid: 'u1',
  storagePath: FILED, filename: 'Invoice.pdf', expiresAt: { toMillis: () => Date.now() + 1e6 },
});

async function serveReport(object) {
  const mod = load('report-sharing.js', { ['report_share_tokens/' + TOKEN]: tokDoc() }, { [FILED]: object });
  const res = mkRes();
  await mod.getSharedReport.__handler({ path: '/report/' + TOKEN, get: () => 'Mozilla/5.0 (iPhone)', headers: {} }, res);
  await new Promise((r) => setImmediate(r));
  return res;
}

const HTML = '<html><body><script>alert(document.domain)</script></body></html>';

(async () => {
  console.log('A. getSharedReport — /report/<token> for a lead document');
  {
    const res = await serveReport({ meta: { contentType: 'text/html' }, body: HTML });
    ok('an object overwritten to text/html → 4xx', res.statusCode >= 400 && res.statusCode < 500, String(res.statusCode));
    ok('…and none of its bytes are sent', !/<script>/.test(res.bytes()) && !/<script>alert/.test(String(res.body || '')));
  }
  {
    const res = await serveReport({ meta: { contentType: 'application/pdf' }, body: HTML });
    ok('an object that CLAIMS application/pdf but is not %PDF → 4xx', res.statusCode >= 400 && res.statusCode < 500, String(res.statusCode));
    ok('…and none of its bytes are sent', !/<script>/.test(res.bytes()));
  }
  {
    const res = await serveReport({ meta: { contentType: 'application/pdf; charset=binary' }, body: '%PDF-1.7 real invoice' });
    ok('a real PDF is still served (200, body intact)', res.statusCode === 200 && res.bytes().startsWith('%PDF-1.7'), res.statusCode + ' ' + res.bytes().slice(0, 20));
    ok('Content-Type is exactly application/pdf (never the object\'s own value)', res.headers['content-type'] === 'application/pdf', res.headers['content-type']);
    ok('X-Content-Type-Options: nosniff', res.headers['x-content-type-options'] === 'nosniff');
    const csp = parseCsp(res.headers['content-security-policy']);
    ok("CSP: sandbox (no allow-* tokens) and default-src 'none'",
      'sandbox' in csp && csp.sandbox.length === 0 && (csp['default-src'] || []).join(' ') === "'none'",
      res.headers['content-security-policy']);
  }

  console.log('B. money-paper files its PDFs locked (signed:true)');
  {
    const src = fs.readFileSync(path.join(FUNCTIONS, 'money-paper.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
    const at = src.indexOf('bucket.file(pdfPath).save(');
    const call = at === -1 ? '' : src.slice(at, src.indexOf('});', at) + 3);
    ok('anchor: the filed-PDF save call is found', !!call);
    ok('the save takes its metadata from money-paper-logic filedPdfMetadata (the helper storage-rules.test.js seeds from)',
      /metadata:\s*P\.filedPdfMetadata\(\s*kind\s*,\s*c\.id\s*,\s*invoiceId\s*\)/.test(call), call.slice(0, 300));
    const P = require(path.join(FUNCTIONS, 'money-paper-logic.js'));
    const m = typeof P.filedPdfMetadata === 'function' ? P.filedPdfMetadata('invoice', 'inv-1', 'i1') : null;
    ok("filedPdfMetadata: application/pdf + custom metadata signed: 'true' (storage.rules lock)",
      !!m && m.contentType === 'application/pdf' && m.metadata && m.metadata.signed === 'true'
        && m.metadata.docCode === 'NBD-500' && m.metadata.instanceId === 'inv-1', JSON.stringify(m));
  }

  console.log('C. getDealRoom — /deal/<token>');
  {
    const DEAL_TOKEN = 'c'.repeat(32);
    const stored = '<!doctype html><html><head><title>Deal</title>'
      + '<meta http-equiv="refresh" content="0;url=https://evil.test/">'
      + '<META HTTP-EQUIV=Content-Security-Policy CONTENT="default-src *">'
      + '<base href="https://evil.test/"><BASE target=_top>'
      + '<meta name="viewport" content="width=device-width"></head><body>deal body</body></html>';
    const mod = load('deal-acceptance.js', {
      ['deal_accept_tokens/' + DEAL_TOKEN]: { status: 'pending', dealId: 'd1', htmlPath: 'deal_rooms/u/d1.html', expiresAt: { toMillis: () => Date.now() + 1e6 } },
      'deal_rooms/d1': { status: 'sent' },
    }, { 'deal_rooms/u/d1.html': { meta: { contentType: 'text/html' }, body: stored } });
    const res = mkRes();
    await mod.getDealRoom.__handler({ path: '/deal/' + DEAL_TOKEN, get: () => 'Mozilla/5.0 (iPhone)', headers: {} }, res);
    const body = String(res.body || '');
    ok('serves the page (control)', res.statusCode === 200 && /deal body/.test(body), String(res.statusCode));
    ok('X-Content-Type-Options: nosniff', res.headers['x-content-type-options'] === 'nosniff');
    const csp = parseCsp(res.headers['content-security-policy']);
    ok("CSP has sandbox and default-src 'none'", 'sandbox' in csp && (csp['default-src'] || []).join(' ') === "'none'",
      res.headers['content-security-policy']);
    const sb = csp.sandbox || [];
    ok('sandbox keeps the ACCEPT flow (allow-scripts + allow-same-origin) but not forms/top-navigation',
      sb.includes('allow-scripts') && sb.includes('allow-same-origin')
        && !sb.includes('allow-forms') && !sb.includes('allow-top-navigation'), sb.join(' '));
    ok('no <meta http-equiv> survives (any case, quoted or not)', !/<meta[^>]*http-equiv/i.test(body), body.slice(0, 300));
    ok('no <base> tag survives', !/<base\b/i.test(body));
    ok('ordinary <meta name=…> tags are kept (viewport + injected deal token)',
      /name="viewport"/.test(body) && /name="nbd-deal-token"/.test(body));
  }

  stubs = null;
  Module._load = realLoad;

  console.log('\n──────────────────────────────────────────────────');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    fails.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
})().catch((e) => {
  console.error('suite crashed:', e && e.stack || e);
  process.exit(1);
});
