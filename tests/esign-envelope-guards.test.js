/**
 * tests/esign-envelope-guards.test.js — two confirmed defects in
 * functions/esign-envelope.js, loaded and RUN for real (not regex).
 *
 * 1. ALL-OPTIONAL ENVELOPES COULD "SIGN" WITH NOTHING FILLED IN.
 *    sendEsignEnvelope's guard against "a document with no signature field
 *    signed successfully" only checked env.fields.length === 0, not that
 *    ANY field was required. docs/pro/js/esign-setup.js lets a rep toggle
 *    every field — including a signature — to optional with one click and
 *    no confirmation. With zero required fields, esign-sign.js's
 *    requiredFields() is empty, so `done < req.length` is `0 < 0` (false):
 *    Finish enables with values = {}, and stampPdf reports
 *    missingRequired: [] because nothing was ever required. The envelope
 *    completes, fully audited, having captured nothing.
 *
 * 2. A REVOKED LINK WAS TOLD "This document has already been signed."
 *    getEsignEnvelope was rebuilt to distinguish signed / revoked / expired
 *    / inactive specifically because the old path's "already signed" on an
 *    expired link was false and un-actionable. submitEsignEnvelope's token
 *    checks never got the same treatment: ANY non-'pending' status —
 *    including 'revoked' — was reported as "already signed", in both the
 *    pre-check and the atomic burn transaction. This is an ordinary
 *    workflow collision, not an edge case: the rep clicks "resend" (which
 *    revokes the live token) while the original signer still has the old
 *    link open.
 *
 * WHY THIS FILE EXECUTES INSTEAD OF GREPPING
 * ───────────────────────────────────────────
 * Both handlers are loaded with `new Function` and every `require` stubbed
 * — the same technique tests/session-revocation.test.js uses — so the real
 * source runs against an in-memory Firestore double and the assertions are
 * about what it DID (threw / didn't throw, what status+body it sent), not
 * what strings appear in it. A regex for `required !== false` would have
 * passed against the pre-fix file just as happily as the post-fix one; the
 * bug was in what check was MISSING, not in a wrong string.
 *
 * Pure Node — no emulator, no firebase-admin, no functions/ deps.
 * Run: node tests/esign-envelope-guards.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'functions', 'esign-envelope.js'), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

// ═══════════════════════════════════════════════════════════════
// A minimal in-memory Firestore double.
//
// Seeding a path with an ARRAY of documents (rather than one object) makes
// successive .get() calls on that doc walk the array, one step per call,
// sticking on the last entry once exhausted. That models a document that
// CHANGES BETWEEN TWO READS — exactly the race in submitEsignEnvelope's
// atomic-burn transaction, where the pre-check and the transaction's own
// tx.get() are two separate reads of the same token.
// ═══════════════════════════════════════════════════════════════
function makeFirestore(seed) {
  const store = new Map(Object.entries(seed || {}));
  const seqIndex = new Map();

  function currentData(p) {
    const v = store.get(p);
    if (Array.isArray(v)) {
      const i = seqIndex.get(p) || 0;
      seqIndex.set(p, Math.min(i + 1, v.length - 1) === i ? i + 1 : i + 1);
      return v[Math.min(i, v.length - 1)];
    }
    return v;
  }

  function applyPatch(prev, patch) {
    const next = Object.assign({}, prev);
    for (const [k, v] of Object.entries(patch)) {
      if (v && v.__fv === 'arrayUnion') {
        next[k] = (Array.isArray(prev && prev[k]) ? prev[k] : []).concat(v.items);
      } else if (v && v.__fv === 'serverTimestamp') {
        next[k] = { __ts: true, toMillis: () => Date.now() };
      } else {
        next[k] = v;
      }
    }
    return next;
  }

  function rawPrev(p) {
    const v = store.get(p);
    return Array.isArray(v) ? v[v.length - 1] : v;
  }

  function makeDocRef(p) {
    return {
      id: p.split('/').pop(),
      get: async () => {
        const data = currentData(p);
        return { exists: data !== undefined, data: () => data, ref: makeDocRef(p), id: p.split('/').pop() };
      },
      set: async (patch, opts) => {
        const prev = (opts && opts.merge) ? (rawPrev(p) || {}) : {};
        store.set(p, applyPatch(prev, patch));
      },
      update: async (patch) => { store.set(p, applyPatch(rawPrev(p) || {}, patch)); },
    };
  }

  function makeQuery(collPath, filters) {
    return {
      where: (f, o, v) => makeQuery(collPath, filters.concat([[f, o, v]])),
      get: async () => {
        const docs = [];
        for (const p of store.keys()) {
          if (!p.startsWith(collPath + '/')) continue;
          const rest = p.slice(collPath.length + 1);
          if (rest.includes('/')) continue;
          const data = rawPrev(p);
          if (filters.every(([f, o, v]) => (o === '==' ? (data && data[f]) === v : true))) {
            docs.push({ id: rest, ref: makeDocRef(p), data: () => data });
          }
        }
        return { size: docs.length, docs, forEach: (fn) => docs.forEach(fn) };
      },
    };
  }

  return {
    doc: (p) => makeDocRef(p),
    collection: (collPath) => ({ where: (f, o, v) => makeQuery(collPath, [[f, o, v]]) }),
    batch: () => {
      const ops = [];
      return {
        update: (ref, data) => ops.push(() => ref.update(data)),
        set: (ref, data, opts) => ops.push(() => ref.set(data, opts)),
        commit: async () => { for (const op of ops) await op(); },
      };
    },
    runTransaction: async (fn) => fn({
      get: (ref) => ref.get(),
      update: (ref, data) => { ref.update(data); },
      set: (ref, data, opts) => { ref.set(data, opts); },
    }),
    _store: store,
  };
}

// ═══════════════════════════════════════════════════════════════
// Load functions/esign-envelope.js with every require stubbed.
// ═══════════════════════════════════════════════════════════════
function loadEsignHandlers(db) {
  class HttpsError extends Error {
    constructor(code, message, details) { super(message); this.code = code; this.details = details; }
  }

  const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

  const storageStub = {
    bucket: () => ({
      file: () => ({
        download: async () => [Buffer.from('%PDF-FAKE')],
      }),
    }),
  };

  const stubs = {
    crypto: require('crypto'),
    'firebase-functions/v2/https': {
      onCall: (options, handler) => { const f = async (request) => handler(request); f.__options = options; return f; },
      onRequest: (options, handler) => { const f = async (req, res) => handler(req, res); f.__options = options; return f; },
      HttpsError,
    },
    'firebase-functions/params': { defineSecret: (name) => ({ name, value: () => 'stub-secret' }) },
    'firebase-functions/v2': { logger: noopLogger },
    'firebase-admin/firestore': {
      Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) },
      getFirestore: () => db,
      FieldValue: {
        serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
        arrayUnion: (...items) => ({ __fv: 'arrayUnion', items }),
      },
    },
    'firebase-admin/storage': { getStorage: () => storageStub },
    './integrations/upstash-ratelimit': { httpRateLimit: async () => true, clientIp: () => '203.0.113.9' },
    // assertNotViewer (2026-09-25): no caller here is a viewer; the refusal
    // itself is tests/viewer-callables.test.js.
    './shared': { callableRateLimit: async () => {}, assertNotViewer: () => {} },
    './esign-stamp': {
      stampPdf: async () => ({ bytes: Buffer.from('%PDF-SIGNED'), missingRequired: [] }),
      readPdfGeometry: async () => [{ w: 612, h: 792 }],
      validateFields: () => {},
      FIELD_TYPES: ['signature', 'initials', 'date', 'text', 'checkbox'],
    },
    './integrations/_shared': { secretOr: (_secret, def) => def },
    './resend-guard': { resendRejected: () => false, resendErrorMessage: () => 'rejected' },
  };

  const requireStub = (id) => {
    if (!Object.prototype.hasOwnProperty.call(stubs, id)) throw new Error('unstubbed require(' + id + ')');
    return stubs[id];
  };

  const mod = { exports: {} };
  new Function('module', 'exports', 'require', 'console', SRC)(
    mod, mod.exports, requireStub, { log: () => {}, warn: () => {}, error: () => {} });
  return { exports: mod.exports, HttpsError };
}

/** Minimal Express-shaped req/res for the onRequest-wrapped handlers. */
function makeReqRes(body) {
  const res = {
    statusCode: null, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    end() { return this; },
  };
  const req = { method: 'POST', body, get: () => 'TestAgent/1.0' };
  return { req, res };
}

async function callAndCatch(fn, request) {
  try { return { value: await fn(request), error: null }; }
  catch (e) { return { value: null, error: e }; }
}

(async function main() {
  console.log('\nesign-envelope-guards\n');

  // ═══════════════════════════════════════════════════════════════
  console.log('1. sendEsignEnvelope refuses an envelope where every field is optional');
  // ═══════════════════════════════════════════════════════════════
  {
    const db = makeFirestore({
      'esign_envelopes/ENVOPT01': {
        ownerUid: 'UID1', leadId: 'LEAD1', status: 'draft', title: 'Warranty',
        signerName: 'Pat', signerEmail: 'pat@example.com',
        fields: [
          { id: 'sig', type: 'signature', page: 0, required: false },
          { id: 'note', type: 'text', page: 0, required: false },
        ],
      },
    });
    const { exports: fns, HttpsError } = loadEsignHandlers(db);
    ok('sendEsignEnvelope is exported', typeof fns.sendEsignEnvelope === 'function');

    const { value, error } = await callAndCatch(fns.sendEsignEnvelope, {
      auth: { uid: 'UID1' }, data: { envelopeId: 'ENVOPT01', sendEmail: false },
    });
    ok('an all-optional-fields envelope is REFUSED, not sent',
      !value && error instanceof HttpsError, value ? JSON.stringify(value) : (error && error.message));
    ok('the refusal is failed-precondition (matches the sibling "no fields" refusal)',
      error && error.code === 'failed-precondition', error && error.code);
    ok('the envelope was NOT marked sent',
      (db._store.get('esign_envelopes/ENVOPT01') || {}).status === 'draft',
      JSON.stringify(db._store.get('esign_envelopes/ENVOPT01')));
  }

  console.log('\n  control: an envelope with at least one required field still sends');
  {
    const db = makeFirestore({
      'esign_envelopes/ENVREQ01': {
        ownerUid: 'UID1', leadId: 'LEAD1', status: 'draft', title: 'Warranty',
        signerName: 'Pat', signerEmail: 'pat@example.com',
        fields: [
          { id: 'sig', type: 'signature', page: 0, required: true },
          { id: 'note', type: 'text', page: 0, required: false },
        ],
      },
    });
    const { exports: fns } = loadEsignHandlers(db);
    const { value, error } = await callAndCatch(fns.sendEsignEnvelope, {
      auth: { uid: 'UID1' }, data: { envelopeId: 'ENVREQ01', sendEmail: false },
    });
    ok('sends without error when a required field exists', !error, error && error.message);
    ok('the envelope is marked sent', value && value.ok === true, JSON.stringify(value));
    ok('status persisted as sent',
      (db._store.get('esign_envelopes/ENVREQ01') || {}).status === 'sent',
      JSON.stringify(db._store.get('esign_envelopes/ENVREQ01')));
  }

  console.log('\n  control: an envelope with zero fields is still refused (the original guard)');
  {
    const db = makeFirestore({
      'esign_envelopes/ENVZERO1': {
        ownerUid: 'UID1', leadId: 'LEAD1', status: 'draft', title: 'Warranty', fields: [],
      },
    });
    const { exports: fns, HttpsError } = loadEsignHandlers(db);
    const { error } = await callAndCatch(fns.sendEsignEnvelope, {
      auth: { uid: 'UID1' }, data: { envelopeId: 'ENVZERO1', sendEmail: false },
    });
    ok('zero-field envelope is refused', error instanceof HttpsError && error.code === 'failed-precondition');
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n2. submitEsignEnvelope tells a REVOKED link something other than "already signed"');
  // ═══════════════════════════════════════════════════════════════
  const ENV_DOC = {
    ownerUid: 'UID1', leadId: 'LEAD1', status: 'sent',
    sourcePath: 'esign/UID1/LEAD1/ENV1/source.pdf',
    fields: [{ id: 'sig', type: 'signature', page: 0, required: true }],
  };

  {
    const TOKEN = 'TOKREVOKED01';
    const db = makeFirestore({
      [`esign_tokens/${TOKEN}`]: { envelopeId: 'ENV1', status: 'revoked' },
      'esign_envelopes/ENV1': ENV_DOC,
    });
    const { exports: fns } = loadEsignHandlers(db);
    const { req, res } = makeReqRes({ token: TOKEN, values: { sig: { png: 'data:image/png;base64,AA==' } }, consent: true, signerName: 'Pat' });
    await fns.submitEsignEnvelope(req, res);

    ok('a revoked-link submit is NOT told "already signed"',
      !/already been signed/i.test((res.body && res.body.error) || ''),
      JSON.stringify(res.body));
    ok('the response carries reason: "revoked" (so the client can branch on it, like getEsignEnvelope\'s callers do)',
      res.body && res.body.reason === 'revoked', JSON.stringify(res.body));
  }

  console.log('\n  control: a genuinely SIGNED token still says "already signed"');
  {
    const TOKEN = 'TOKSIGNED001';
    const db = makeFirestore({
      [`esign_tokens/${TOKEN}`]: { envelopeId: 'ENV1', status: 'signed' },
      'esign_envelopes/ENV1': ENV_DOC,
    });
    const { exports: fns } = loadEsignHandlers(db);
    const { req, res } = makeReqRes({ token: TOKEN, values: { sig: { png: 'x' } }, consent: true, signerName: 'Pat' });
    await fns.submitEsignEnvelope(req, res);
    ok('a signed token still reads "already signed"', /already been signed/i.test((res.body && res.body.error) || ''), JSON.stringify(res.body));
    ok('reason: "signed"', res.body && res.body.reason === 'signed', JSON.stringify(res.body));
  }

  console.log('\n  the same distinction holds in the ATOMIC BURN TRANSACTION (a resend racing a submit)');
  {
    // First .get() (the pre-check) sees 'pending'; the SECOND .get() (the
    // transaction's own tx.get(), a separate read) sees 'revoked' — modeling
    // a rep's "resend" landing in the gap between the two reads.
    const TOKEN = 'TOKRACE00001';
    const db = makeFirestore({
      [`esign_tokens/${TOKEN}`]: [
        { envelopeId: 'ENV1', status: 'pending' },
        { envelopeId: 'ENV1', status: 'revoked' },
      ],
      'esign_envelopes/ENV1': ENV_DOC,
    });
    const { exports: fns } = loadEsignHandlers(db);
    const { req, res } = makeReqRes({ token: TOKEN, values: { sig: { png: 'data:image/png;base64,AA==' } }, consent: true, signerName: 'Pat' });
    await fns.submitEsignEnvelope(req, res);

    ok('the race is caught (a response was sent)', res.statusCode != null, JSON.stringify(res.body));
    ok('the transaction-path response is also NOT "already signed"',
      !/already been signed/i.test((res.body && res.body.error) || ''), JSON.stringify(res.body));
    ok('the transaction-path response also carries reason: "revoked"',
      res.body && res.body.reason === 'revoked', JSON.stringify(res.body));
  }

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed) { console.log('\n  failures:'); for (const f of fails) console.log('    - ' + f); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('\nFATAL', (e && e.stack) || e); process.exit(1); });
