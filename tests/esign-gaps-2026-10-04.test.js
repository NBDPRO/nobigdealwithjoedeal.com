/**
 * tests/esign-gaps-2026-10-04.test.js — the in-house e-sign, run for real,
 * after BoldSign was retired (Jo, 2026-10-04: "retire BoldSign as long as
 * we're fully operational with our own").
 *
 * Every gap the parity audit found in our own e-sign is driven end to end
 * here against an in-memory Firestore + Storage, with the REAL handlers
 * (functions/esign-envelope.js, esign-reminders.js — loaded with `new
 * Function`, the same technique as tests/esign-envelope-guards.test.js), the
 * REAL pure modules (esign-logic, estimate-esign-pdf, ky-insurance-law,
 * customer-estimate-rows, deposit-plan-view) and the REAL pdf-lib stamper:
 *
 *   A. sendEstimateEnvelope — "Send for signature" from an estimate: builds
 *      the contract PDF from the SAVED estimate (retail rows, never cost),
 *      places each signer's boxes, sends signer 1, mirrors status onto the
 *      estimate. Refuses Kentucky insurance / not-yours / no customer / no
 *      price / already signed.
 *   B. MULTI-SIGNER — signer 1 sees only their fields, cannot fill signer 2's,
 *      signs; signer 2 gets their own link; the last signature assembles every
 *      value onto the ORIGINAL in one pass.
 *   C. EVIDENCE (break-tests): consent + text, IP, user agent, time, typed
 *      name, values digest — per signer; the source and signed SHA-256; the
 *      certificate page; a tampered vault is refused.
 *   D. DELIVERY — signed PDF stored, emailed to every signer (emulator stub
 *      records it; nothing is sent), FTC notice dates filled at signing.
 *   E. DECLINE — burns the link, records who/why, tells the rep, mirrors.
 *   F. REMINDERS + EXPIRY — esign-reminders.js runSweep.
 *   G. A pre-multi-signer envelope (no signers[], token without signerId)
 *      still signs.
 *   J. The cancellation notice (#2149) is appended to a contract envelope's
 *      signed PDF — never to one that already carries its forms
 *      (cancelFormsIncluded, the estimate path above).
 *
 * Pure Node (pdf-lib from functions/node_modules). No emulator, no network.
 * Run: node tests/esign-gaps-2026-10-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
module.paths.unshift(path.join(FN, 'node_modules'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ── A real PNG signature (24x24 black) ─────────────────────────────────
const PNG = (() => {
  const W = 24, H = 24;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  const idat = zlib.deflateSync(raw);
  const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return 'data:image/png;base64,' + Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
})();

/** Visible text of a pdf-lib PDF: inflate content streams, decode <hex> Tj. */
function pdfText(bytes) {
  const s = Buffer.from(bytes).toString('latin1');
  const out = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    let body = Buffer.from(s.slice(start, end), 'latin1');
    try { body = zlib.inflateSync(body); } catch (_) { /* not flate — use as is */ }
    const txt = body.toString('latin1');
    const tj = /<([0-9A-Fa-f]+)>\s*Tj/g;
    let t;
    while ((t = tj.exec(txt))) out.push(Buffer.from(t[1], 'hex').toString('latin1'));
    re.lastIndex = end + 'endstream'.length;
  }
  return out.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// In-memory Firestore (merge + nested-map merge + sentinels + queries)
// ═══════════════════════════════════════════════════════════════
function isPlain(v) { return v && typeof v === 'object' && !Array.isArray(v) && !v.__fv && !Buffer.isBuffer(v) && typeof v.toMillis !== 'function'; }
function applyPatch(prev, patch, deep) {
  const next = Object.assign({}, prev || {});
  for (const [k, v] of Object.entries(patch)) {
    if (v && v.__fv === 'delete') { delete next[k]; continue; }
    if (v && v.__fv === 'arrayUnion') { next[k] = (Array.isArray(next[k]) ? next[k] : []).concat(v.items); continue; }
    if (v && v.__fv === 'serverTimestamp') { const now = Date.now(); next[k] = { __ts: true, toMillis: () => now }; continue; }
    if (deep && isPlain(v) && isPlain(next[k])) { next[k] = applyPatch(next[k], v, true); continue; }
    next[k] = v;
  }
  return next;
}
function makeDb(seed) {
  const store = new Map(Object.entries(seed || {}));
  let autoId = 0;
  const ref = (p) => ({
    id: p.split('/').pop(), path: p,
    get: async () => { const d = store.get(p); return { exists: d !== undefined, data: () => d, ref: ref(p), id: p.split('/').pop() }; },
    set: async (patch, opts) => { store.set(p, applyPatch((opts && opts.merge) ? store.get(p) : {}, patch, !!(opts && opts.merge))); },
    update: async (patch) => {
      if (!store.has(p)) throw new Error('NOT_FOUND ' + p);
      // Firestore update(): a dotted key is a field PATH into a map.
      const flat = {}; const dotted = [];
      for (const [k, v] of Object.entries(patch)) (k.includes('.') ? dotted.push([k, v]) : (flat[k] = v));
      const next = applyPatch(store.get(p), flat, false);
      for (const [k, v] of dotted) {
        const parts = k.split('.'); let o = next;
        for (let i = 0; i < parts.length - 1; i++) { o[parts[i]] = Object.assign({}, o[parts[i]] || {}); o = o[parts[i]]; }
        o[parts[parts.length - 1]] = v;
      }
      store.set(p, next);
    },
  });
  const cmp = (o, a, b) => (o === '==' ? a === b : o === '<=' ? (a != null && a <= b) : o === '<' ? (a != null && a < b) : o === '>=' ? (a != null && a >= b) : false);
  const query = (coll, filters, lim) => ({
    where: (f, o, v) => query(coll, filters.concat([[f, o, v]]), lim),
    limit: (n) => query(coll, filters, n),
    get: async () => {
      const docs = [];
      for (const [p, d] of store) {
        if (!p.startsWith(coll + '/') || p.slice(coll.length + 1).includes('/')) continue;
        if (filters.every(([f, o, v]) => cmp(o, d && d[f], v))) docs.push({ id: p.split('/').pop(), ref: ref(p), data: () => store.get(p) });
      }
      const sl = lim ? docs.slice(0, lim) : docs;
      return { size: sl.length, docs: sl, empty: !sl.length, forEach: (fn) => sl.forEach(fn) };
    },
  });
  return {
    doc: ref,
    collection: (coll) => Object.assign(query(coll, []), {
      add: async (data) => { const id = 'auto' + (++autoId); store.set(coll + '/' + id, applyPatch({}, data)); return ref(coll + '/' + id); },
    }),
    batch: () => { const ops = []; return { update: (r, d) => ops.push(() => r.update(d)), set: (r, d, o) => ops.push(() => r.set(d, o)), commit: async () => { for (const op of ops) await op(); } }; },
    runTransaction: async (fn) => {
      const writes = [];
      const out = await fn({ get: (r) => r.get(), update: (r, d) => writes.push(() => r.update(d)), set: (r, d, o) => writes.push(() => r.set(d, o)) });
      for (const w of writes) await w();
      return out;
    },
    _store: store,
    _get: (p) => store.get(p),
    _all: (coll) => [...store.entries()].filter(([p]) => p.startsWith(coll + '/')).map(([p, d]) => Object.assign({ _id: p.split('/').pop() }, d)),
  };
}
function makeStorage() {
  const files = new Map();
  return {
    files,
    getStorage: () => ({ bucket: () => ({ file: (p) => ({
      save: async (buf) => { files.set(p, Buffer.from(buf)); },
      download: async () => { if (!files.has(p)) throw new Error('No such object: ' + p); return [Buffer.from(files.get(p))]; },
      getMetadata: async () => [{ size: files.has(p) ? files.get(p).length : 0 }],
      getSignedUrl: async () => ['https://storage.example/' + p],
    }) }) }),
  };
}

// ═══════════════════════════════════════════════════════════════
// Load the real handlers under stubs.
// ═══════════════════════════════════════════════════════════════
function load(db, storage) {
  class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const mails = [];
  const logs = [];
  const logger = {
    info: (m, d) => { logs.push(['info', m, d]); if (/email NOT sent \(emulator stub\)/.test(m)) mails.push(d); },
    warn: (m, d) => logs.push(['warn', m, d]),
    error: (m, d) => logs.push(['error', m, d]),
  };
  const spine = [];
  const stubs = {
    crypto,
    'firebase-functions/v2/https': {
      onCall: (o, h) => { const f = async (r) => h(r); f.__options = o; return f; },
      onRequest: (o, h) => { const f = async (q, s) => h(q, s); f.__options = o; return f; },
      HttpsError,
    },
    'firebase-functions/params': { defineSecret: (name) => ({ name, value: () => 'stub' }) },
    'firebase-functions/v2': { logger },
    'firebase-admin/firestore': {
      Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) },
      getFirestore: () => db,
      FieldValue: {
        serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
        arrayUnion: (...items) => ({ __fv: 'arrayUnion', items }),
        delete: () => ({ __fv: 'delete' }),
      },
    },
    'firebase-admin/storage': { getStorage: storage.getStorage },
    './integrations/upstash-ratelimit': { httpRateLimit: async () => true, clientIp: (req) => req.__ip || '203.0.113.9' },
    './shared': { callableRateLimit: async () => {}, assertNotViewer: () => {} },
    './integrations/_shared': { secretOr: (_s, d) => d },
    './resend-guard': { resendRejected: () => false, resendErrorMessage: () => 'rejected' },
    './job-spine': { spineAfterEsign: async (_db, env, id) => { spine.push(id); return {}; } },
    './esign-stamp': require(path.join(FN, 'esign-stamp.js')),
    './esign-logic': require(path.join(FN, 'esign-logic.js')),
    './estimate-esign-pdf': require(path.join(FN, 'estimate-esign-pdf.js')),
    './ky-insurance-law': require(path.join(FN, 'ky-insurance-law.js')),
    './customer-estimate-rows': require(path.join(FN, 'customer-estimate-rows.js')),
    './deposit-plan-view': require(path.join(FN, 'deposit-plan-view.js')),
    './cancel-window': require(path.join(FN, 'cancel-window.js')),
    './cancel-notice-pdf': require(path.join(FN, 'cancel-notice-pdf.js')),
    './integrations/heartbeat': { onSchedule: (o, h) => { const f = async () => h(); f.__options = o; return f; } },
  };
  // The Functions emulator sets FUNCTIONS_EMULATOR=true; esign-io's sendMail
  // then logs instead of sending — the "No real emails" guarantee, used here.
  const proc = { env: { FUNCTIONS_EMULATOR: 'true' } };
  const req = (id) => {
    if (id === './esign-io' && !stubs[id]) stubs[id] = run('esign-io.js');
    if (!Object.prototype.hasOwnProperty.call(stubs, id)) throw new Error('unstubbed require(' + id + ')');
    return stubs[id];
  };
  function run(file) {
    const mod = { exports: {} };
    new Function('module', 'exports', 'require', 'process', 'console', fs.readFileSync(path.join(FN, file), 'utf8'))(
      mod, mod.exports, req, proc, { log() {}, warn() {}, error() {} });
    return mod.exports;
  }
  const env = run('esign-envelope.js');
  const rem = run('esign-reminders.js');
  return { fns: env, rem, HttpsError, mails, logs, spine };
}

function reqRes(body, ip, ua) {
  const res = {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    set() { return this; }, end() { return this; },
  };
  const req = { method: 'POST', body, __ip: ip || '203.0.113.9', get: (h) => (/user-agent/i.test(h) ? (ua || 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)') : '') };
  return { req, res };
}
async function call(fn, request) {
  try { return { value: await fn(request), error: null }; } catch (e) { return { value: null, error: e }; }
}
async function http(fn, body, ip, ua) { const { req, res } = reqRes(body, ip, ua); await fn(req, res); return res; }

const UID = 'UID_OWNER';
const OH_LEAD = { userId: UID, companyId: UID, firstName: 'Pat', lastName: 'Smith', address: '5 Vine St, Cincinnati, OH 45202', phone: '513-555-0101', email: 'pat@example.test', jobType: 'retail' };
// A post-sweep V2 estimate: retail lives in retailTotal; materialTotal /
// laborTotal are the COST basis, which must never reach the contract.
const ESTIMATE = {
  userId: UID, leadId: 'LEAD1', mode: 'cash', grandTotal: 12345.67, total: 12345.67, number: 'E-1001',
  addr: '5 Vine St, Cincinnati, OH 45202', tier: 'better',
  materialMarkupPct: 0.35,
  rows: [
    { code: 'RFG-SHG', desc: 'Architectural shingles, installed', qty: '20.00 SQ', rate: '$450/SQ', total: 9000, retailTotal: 9000, materialTotal: 4111.11, laborTotal: 1999.99 },
    { code: 'RFG-DRIP', desc: 'Drip edge, aluminum', qty: '180 LF', rate: '$18.58/LF', total: 3345.67, retailTotal: 3345.67, materialTotal: 777.77, laborTotal: 555.55 },
    // A catalog line left at 0 / $0 is not part of the job.
    { code: 'DUMP-20', desc: 'Dumpster 20-Yard (unused)', qty: '0.00JOB', rate: '$0/JOB', total: 0, retailTotal: 0 },
  ],
  depositPlan: { totalCents: 1234567, depositCents: 617284, balanceCents: 617283, label: 'Due at signing', valueText: '$6,172.84', summary: 'Half at signing, the balance when the roof is done.', rows: [] },
};
function seed(extra) {
  return Object.assign({
    'leads/LEAD1': JSON.parse(JSON.stringify(OH_LEAD)),
    'estimates/EST1': JSON.parse(JSON.stringify(ESTIMATE)),
    'companyProfile/UID_OWNER': { brand: { legalName: 'Acme Roofing LLC', contact: { mailingAddress: '1 Main St, Cincinnati, OH 45202' } }, timezone: 'America/New_York' },
  }, extra || {});
}
const AUTH = { auth: { uid: UID, token: { role: 'owner' } } };
const tokenFor = (db, envelopeId, signerId) => {
  const t = db._all('esign_tokens').find((x) => x.envelopeId === envelopeId && x.status === 'pending' && (x.signerId || 'signer') === signerId);
  return t ? t._id : null;
};

(async function main() {
  console.log('\nesign-gaps-2026-10-04 — the in-house e-sign, end to end\n');

  // ═══════════════════════════════════════════════════════════
  console.log('A. sendEstimateEnvelope — "Send for signature" from an estimate');
  // ═══════════════════════════════════════════════════════════
  const db = makeDb(seed());
  const st = makeStorage();
  const L = load(db, st);
  const sent = await call(L.fns.sendEstimateEnvelope, Object.assign({ data: {
    estimateId: 'EST1',
    signers: [{ name: 'Pat Smith', email: 'Pat@Example.test' }, { name: 'Sam Smith', email: 'sam@example.test' }],
  } }, AUTH));
  ok('sends without error', !sent.error, sent.error && sent.error.message);
  const out = sent.value || {};
  const envId = out.envelopeId;
  ok('returns the envelope id and a single-use esign.html link', /^est_EST1_/.test(envId || '') && /^https:\/\/nobigdealwithjoedeal\.com\/pro\/esign\.html\?t=[A-Z2-9]{24}$/.test(out.link || ''), JSON.stringify(out));
  ok('reports 2 signers, link for signer 1', out.signerCount === 2 && out.signerId === 'signer');
  ok('emulator: the email was NOT sent (stub), and says so', out.emailed === false && out.stubbed === true);
  ok('the stub recorded exactly one email, to signer 1 only', L.mails.length === 1 && L.mails[0].to === 'pat@example.test', JSON.stringify(L.mails));
  const env1 = db._get('esign_envelopes/' + envId) || {};
  ok('envelope is sent, kind estimate, linked to the estimate + lead', env1.status === 'sent' && env1.kind === 'estimate' && env1.estimateId === 'EST1' && env1.leadId === 'LEAD1');
  ok('two signers, in order, emails lower-cased', Array.isArray(env1.signers) && env1.signers.length === 2 && env1.signers[0].email === 'pat@example.test' && env1.signers[1].id === 'signer2');
  ok('each signer owns a required signature + date field', ['signer', 'signer2'].every((id) => (env1.fields || []).filter((f) => f.role === id && f.required).map((f) => f.type).sort().join() === 'date,signature'));
  ok('FTC system fields are carried (4: date + deadline, two copies)', (env1.systemFields || []).length === 4);
  ok('cancelFormsIncluded is flagged (no second set appended later)', env1.cancelFormsIncluded === true);
  ok('reminders armed for 2 days out', env1.reminders && env1.reminders.enabled === true && env1.remindNextAt > Date.now() + 86_400_000);
  const src1 = st.files.get(env1.sourcePath);
  ok('source PDF stored at the owner prefix, digest recorded', !!src1 && env1.sourcePath === `esign/${UID}/LEAD1/${envId}/source.pdf` && env1.sourceSha256 === sha256(src1));
  const text = src1 ? pdfText(src1) : '';
  ok('contract shows the contract price from the saved estimate', /Contract price: \$12,345\.67/.test(text), text.slice(0, 300));
  ok('contract shows the RETAIL line amounts', /\$9,000\.00/.test(text) && /\$3,345\.67/.test(text));
  ok('contract never shows the COST basis', !/4,111\.11|1,999\.99|777\.77|555\.55/.test(text));
  ok('a zero-quantity $0 line is not printed on the contract', !/Dumpster 20-Yard/.test(text));
  ok('contract carries the deposit plan sentence', /Half at signing/.test(text));
  ok('16 CFR 429.1(a) statement printed by the signatures', /You, the buyer, may cancel this transaction/.test(text));
  ok('two FTC NOTICE OF CANCELLATION forms with the seller address', (text.match(/NOTICE OF CANCELLATION/g) || []).length === 2 && /1 Main St, Cincinnati, OH 45202/.test(text));
  ok('tenant legal name, not NBD, heads the contract', /Acme Roofing LLC/.test(text));
  const est1 = db._get('estimates/EST1');
  ok('estimate mirrors: signatureStatus sent, provider nbd-esign, envelope id', est1.signatureStatus === 'sent' && est1.signatureProvider === 'nbd-esign' && est1.signatureEnvelopeId === envId);
  ok('exactly one live token, for signer 1', db._all('esign_tokens').filter((t) => t.status === 'pending').length === 1 && !!tokenFor(db, envId, 'signer'));

  console.log('\n  refusals');
  {
    const dbK = makeDb(seed({ 'leads/LEAD1': Object.assign({}, OH_LEAD, { address: '12 Dixie Hwy, Florence, KY 41042', jobType: 'insurance', claimNumber: 'C-9', insCarrier: 'State Farm' }) }));
    const r = await call(load(dbK, makeStorage()).fns.sendEstimateEnvelope, Object.assign({ data: { estimateId: 'EST1', signers: [{ name: 'Pat', email: 'pat@example.test' }] } }, AUTH));
    ok('Kentucky insurance job → refused (KRS 367.624 notices are not on this contract)', r.error && r.error.code === 'failed-precondition' && /Kentucky/.test(r.error.message), r.error && r.error.message);
    ok('…and nothing was created', dbK._all('esign_envelopes').length === 0 && dbK._all('esign_tokens').length === 0);
  }
  {
    const dbO = makeDb(seed());
    const r = await call(load(dbO, makeStorage()).fns.sendEstimateEnvelope, { auth: { uid: 'SOMEONE_ELSE', token: {} }, data: { estimateId: 'EST1', signers: [{ name: 'Pat', email: 'pat@example.test' }] } });
    ok('someone else\'s estimate → permission-denied', r.error && r.error.code === 'permission-denied');
  }
  {
    const dbN = makeDb(seed({ 'estimates/EST1': Object.assign({}, ESTIMATE, { leadId: null }) }));
    const r = await call(load(dbN, makeStorage()).fns.sendEstimateEnvelope, Object.assign({ data: { estimateId: 'EST1', signers: [{ name: 'Pat', email: 'pat@example.test' }] } }, AUTH));
    ok('no linked customer → failed-precondition', r.error && r.error.code === 'failed-precondition' && /customer/.test(r.error.message));
  }
  {
    const dbP = makeDb(seed({ 'estimates/EST1': Object.assign({}, ESTIMATE, { grandTotal: 0, total: 0 }) }));
    const r = await call(load(dbP, makeStorage()).fns.sendEstimateEnvelope, Object.assign({ data: { estimateId: 'EST1', signers: [{ name: 'Pat', email: 'pat@example.test' }] } }, AUTH));
    ok('no price → failed-precondition', r.error && r.error.code === 'failed-precondition' && /Price/.test(r.error.message));
  }
  {
    const dbS = makeDb(seed({ 'estimates/EST1': Object.assign({}, ESTIMATE, { signatureStatus: 'signed' }) }));
    const r = await call(load(dbS, makeStorage()).fns.sendEstimateEnvelope, Object.assign({ data: { estimateId: 'EST1', signers: [{ name: 'Pat', email: 'pat@example.test' }] } }, AUTH));
    ok('already signed → failed-precondition', r.error && r.error.code === 'failed-precondition' && /already signed/.test(r.error.message));
  }
  {
    const dbE = makeDb(seed());
    const r = await call(load(dbE, makeStorage()).fns.sendEstimateEnvelope, Object.assign({ data: { estimateId: 'EST1', signers: [{ name: 'Pat', email: '' }] } }, AUTH));
    ok('remote send without an email → invalid-argument', r.error && r.error.code === 'invalid-argument');
    const r2 = await call(load(dbE, makeStorage()).fns.sendEstimateEnvelope, Object.assign({ data: { estimateId: 'EST1', signers: [{ name: 'Pat', email: '' }], sendEmail: false } }, AUTH));
    ok('in person (sendEmail:false) needs no email and returns the link', !r2.error && /esign\.html\?t=/.test(r2.value.link), r2.error && r2.error.message);
  }

  // ═══════════════════════════════════════════════════════════
  console.log('\nB. Multi-signer — each signer, their own fields, in order');
  // ═══════════════════════════════════════════════════════════
  const t1 = tokenFor(db, envId, 'signer');
  const view1 = await http(L.fns.getEsignEnvelope, { token: t1 }, '198.51.100.7');
  ok('signer 1 loads the document', view1.statusCode === 200 && typeof view1.body.pdf === 'string', JSON.stringify(view1.body && view1.body.error));
  ok('signer 1 sees ONLY their own fields', (view1.body.fields || []).length === 2 && view1.body.fields.every((f) => f.role === 'signer'));
  ok('the page knows it is signer 1 of 2 and may decline', view1.body.signerIndex === 0 && view1.body.signerCount === 2 && view1.body.canDecline === true);
  ok('first view recorded per signer, envelope → viewed, estimate → viewed',
    db._get('esign_envelopes/' + envId).viewedBy && db._get('esign_envelopes/' + envId).viewedBy.signer > 0
    && db._get('esign_envelopes/' + envId).status === 'viewed' && db._get('estimates/EST1').signatureStatus === 'viewed');
  ok('consent text is served for the signer to read', /legal equivalent of my handwritten signature/.test(view1.body.consentText || ''));

  const foreign = await http(L.fns.submitEsignEnvelope, { token: t1, consent: true, signerName: 'Pat Smith', values: { sig_signer: { png: PNG }, date_signer: { text: '10/04/2026' }, sig_signer2: { png: PNG } } });
  ok('signer 1 filling signer 2\'s box is REFUSED', foreign.statusCode === 400 && /only fill in your own/.test(foreign.body.error || ''), JSON.stringify(foreign.body));
  ok('…and the refused submit did not burn the link', db._get('esign_tokens/' + t1).status === 'pending');

  const noConsent = await http(L.fns.submitEsignEnvelope, { token: t1, consent: false, signerName: 'Pat Smith', values: { sig_signer: { png: PNG }, date_signer: { text: '10/04/2026' } } });
  ok('no consent → refused before anything is burned', noConsent.statusCode === 400 && db._get('esign_tokens/' + t1).status === 'pending');

  const missing = await http(L.fns.submitEsignEnvelope, { token: t1, consent: true, signerName: 'Pat Smith', values: { date_signer: { text: '10/04/2026' } } });
  ok('a missing required signature → 422 with the field, link not burned', missing.statusCode === 422 && (missing.body.missing || []).includes('sig_signer') && db._get('esign_tokens/' + t1).status === 'pending');

  const s1 = await http(L.fns.submitEsignEnvelope, { token: t1, consent: true, signerName: 'Patricia Smith', values: { sig_signer: { png: PNG }, date_signer: { text: '10/04/2026' } } }, '198.51.100.7', 'Mozilla/5.0 (iPhone) Signer1');
  ok('signer 1 submits: ok, not complete, next signer named', s1.statusCode === 200 && s1.body.ok === true && s1.body.complete === false && s1.body.nextSigner === 'Sam Smith', JSON.stringify(s1.body));
  ok('signer 1\'s link is burned', db._get('esign_tokens/' + t1).status === 'signed');
  const t2 = tokenFor(db, envId, 'signer2');
  ok('signer 2 now holds the only live link', !!t2 && db._all('esign_tokens').filter((t) => t.status === 'pending').length === 1);
  ok('signer 2 was emailed their link (stub)', L.mails.some((m) => m.to === 'sam@example.test' && /Please sign/.test(m.subject)));
  ok('the rep was told signer 1 signed and who is next', db._all('notifications').some((n) => n.type === 'esign_signer_signed' && /Sam Smith/.test(n.message)));
  ok('no signed PDF yet (the record is built once, at the end)', !st.files.has(`esign/${UID}/LEAD1/${envId}/signed.pdf`));
  ok('signer 1\'s values wait in the vault, not on any client-readable path', st.files.has(`esign-vault/${envId}/signer.json`));
  const rs1 = await http(L.fns.submitEsignEnvelope, { token: t1, consent: true, signerName: 'Pat', values: { sig_signer: { png: PNG }, date_signer: { text: 'x' } } });
  ok('replaying signer 1\'s link → 409 already signed', rs1.statusCode === 409 && rs1.body.reason === 'signed');

  // ═══════════════════════════════════════════════════════════
  console.log('\nC. Evidence — per signer (break-tests: each fact must be present and right)');
  // ═══════════════════════════════════════════════════════════
  const ESL = require(path.join(FN, 'esign-logic.js'));
  const afterOne = db._get('esign_envelopes/' + envId);
  const ev1 = afterOne.signers[0];
  ok('signer 1 evidence: consent agreed', ev1.consent && ev1.consent.agreed === true);
  ok('signer 1 evidence: the exact consent text shown', ev1.consent && ev1.consent.text === ESL.CONSENT_TEXT);
  ok('signer 1 evidence: IP', ev1.ip === '198.51.100.7' && ev1.consent.ip === '198.51.100.7');
  ok('signer 1 evidence: user agent', ev1.ua === 'Mozilla/5.0 (iPhone) Signer1' && ev1.consent.ua === ev1.ua);
  ok('signer 1 evidence: signed + consent timestamps', ev1.signedAt > 0 && ev1.consent.at === ev1.signedAt);
  ok('signer 1 evidence: the typed legal name', ev1.typedName === 'Patricia Smith');
  ok('signer 1 evidence: digest of exactly what they submitted', ev1.valuesSha256 === sha256(st.files.get(`esign-vault/${envId}/signer.json`)));
  ok('signer 1 evidence: first-view time carried over', ev1.viewedAt > 0);
  ok('missingEvidence() is empty for signer 1', ESL.missingEvidence(ev1).length === 0, JSON.stringify(ESL.missingEvidence(ev1)));
  ok('signer 2 has no evidence yet', afterOne.signers[1].status === 'pending' && !afterOne.signers[1].ip);

  console.log('\n  break-test: missingEvidence() names each fact that is absent');
  for (const k of ESL.REQUIRED_EVIDENCE) {
    const copy = JSON.parse(JSON.stringify(ev1));
    const parts = k.split('.');
    let o = copy; for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
    delete o[parts[parts.length - 1]];
    ok('dropping ' + k + ' is caught', ESL.missingEvidence(copy).includes(k));
  }

  console.log('\n  a tampered vault is never drawn into the contract');
  {
    const dbT = makeDb(seed());
    const stT = makeStorage();
    const LT = load(dbT, stT);
    const s = await call(LT.fns.sendEstimateEnvelope, Object.assign({ data: { estimateId: 'EST1', signers: [{ name: 'Pat', email: 'pat@example.test' }, { name: 'Sam', email: 'sam@example.test' }] } }, AUTH));
    const e = s.value.envelopeId;
    await http(LT.fns.submitEsignEnvelope, { token: tokenFor(dbT, e, 'signer'), consent: true, signerName: 'Pat', values: { sig_signer: { png: PNG }, date_signer: { text: '10/04/2026' } } });
    stT.files.set(`esign-vault/${e}/signer.json`, Buffer.from(JSON.stringify({ sig_signer: { png: PNG }, date_signer: { text: '01/01/2020' } })));
    const r = await http(LT.fns.submitEsignEnvelope, { token: tokenFor(dbT, e, 'signer2'), consent: true, signerName: 'Sam', values: { sig_signer2: { png: PNG }, date_signer2: { text: '10/04/2026' } } });
    ok('vault digest mismatch → the envelope does NOT complete', r.statusCode === 500 && dbT._get('esign_envelopes/' + e).status !== 'completed', JSON.stringify(r.body));
    ok('…no signed PDF is written', !stT.files.has(`esign/${UID}/LEAD1/${e}/signed.pdf`));
    ok('…and the rep is told it needs attention', dbT._all('notifications').some((n) => n.type === 'esign_attention'));
  }

  // ═══════════════════════════════════════════════════════════
  console.log('\nD. The last signature — the executed record, delivered');
  // ═══════════════════════════════════════════════════════════
  const view2 = await http(L.fns.getEsignEnvelope, { token: t2 }, '192.0.2.44');
  ok('signer 2 sees ONLY their fields, as signer 2 of 2, with 1 already signed',
    (view2.body.fields || []).every((f) => f.role === 'signer2') && view2.body.signerIndex === 1 && view2.body.othersSigned === 1);
  const mailsBefore = L.mails.length;
  const s2 = await http(L.fns.submitEsignEnvelope, { token: t2, consent: true, signerName: 'Sam Smith', values: { sig_signer2: { png: PNG }, date_signer2: { text: '10/04/2026' } } }, '192.0.2.44', 'Mozilla/5.0 (Android) Signer2');
  ok('signer 2 submits: complete', s2.statusCode === 200 && s2.body.complete === true, JSON.stringify(s2.body));
  const done = db._get('esign_envelopes/' + envId);
  const signedPath = `esign/${UID}/LEAD1/${envId}/signed.pdf`;
  const signedBuf = st.files.get(signedPath);
  ok('envelope completed, signed PDF stored at the owner prefix', done.status === 'completed' && done.signedPath === signedPath && !!signedBuf);
  ok('signed digest recorded and matches the stored bytes', done.signedSha256 === sha256(signedBuf));
  ok('the source was never overwritten', sha256(st.files.get(done.sourcePath)) === done.sourceSha256);
  ok('both signers carry complete evidence', done.signers.every((s) => ESL.missingEvidence(s).length === 0), JSON.stringify(done.signers.map((s) => ESL.missingEvidence(s))));
  ok('signer 2 evidence is signer 2\'s own (IP / UA)', done.signers[1].ip === '192.0.2.44' && done.signers[1].ua === 'Mozilla/5.0 (Android) Signer2');
  const { PDFDocument } = require(path.join(FN, 'node_modules', 'pdf-lib'));
  const srcPages = (await PDFDocument.load(st.files.get(done.sourcePath))).getPageCount();
  const signedPages = (await PDFDocument.load(signedBuf)).getPageCount();
  ok('a signature certificate page is appended', signedPages === srcPages + 1, srcPages + ' → ' + signedPages);
  const stext = pdfText(signedBuf);
  ok('certificate names both signers, their IPs, consent and the source digest',
    /Signature Certificate/.test(stext) && /Patricia Smith/.test(stext) && /Sam Smith/.test(stext)
    && /198\.51\.100\.7/.test(stext) && /192\.0\.2\.44/.test(stext) && /AGREED at/.test(stext)
    && stext.replace(/\s+/g, '').includes(done.sourceSha256));
  const ky = require(path.join(FN, 'ky-insurance-law.js'));
  const today = ky.formatDay(ky.todayIn('America/New_York'));
  ok('the FTC forms are dated the signing day (system fields filled)', (stext.match(new RegExp(today.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length >= 2, today);
  // #2149 appends the notice + forms to envelopes titled as the contract;
  // this one's title is "Roofing Contract — …" but its PDF already has them
  // (cancelFormsIncluded) — exactly one set, no appended notice pages.
  ok('ONE set of FTC forms: 2 completed NOTICE OF CANCELLATION copies, no appended notice (cancelFormsIncluded)',
    done.cancelFormsIncluded === true && (stext.match(/NOTICE OF CANCELLATION/g) || []).length === 2 && !/Notice of Right to Cancel/i.test(stext),
    'forms=' + (stext.match(/NOTICE OF CANCELLATION/g) || []).length);
  ok('cancelBy recorded on the envelope and the lead', /^\d{4}-\d{2}-\d{2}$/.test(done.cancelBy || '') && db._get('leads/LEAD1').cancelBy === done.cancelBy);
  const copies = L.mails.slice(mailsBefore).filter((m) => /^Signed copy:/.test(m.subject));
  ok('the signed copy goes to EVERY signer', copies.length === 2 && copies.map((m) => m.to).sort().join() === 'pat@example.test,sam@example.test', JSON.stringify(copies));
  ok('delivery is recorded per signer', Array.isArray(done.copiesDelivered) && done.copiesDelivered.length === 2);
  ok('estimate mirrors: signed, with the envelope path', db._get('estimates/EST1').signatureStatus === 'signed' && db._get('estimates/EST1').signedEnvelopePath === signedPath);
  ok('reminders + link expiry cleared on completion', done.remindNextAt === undefined && done.linkExpiresAt === undefined);
  ok('job spine ran once for the contract', L.spine.filter((x) => x === envId).length === 1);
  ok('the rep is told it is signed', db._all('notifications').some((n) => n.type === 'esign_completed'));

  // ═══════════════════════════════════════════════════════════
  console.log('\nE. Decline');
  // ═══════════════════════════════════════════════════════════
  {
    const dbD = makeDb(seed());
    const LD = load(dbD, makeStorage());
    const s = await call(LD.fns.sendEstimateEnvelope, Object.assign({ data: { estimateId: 'EST1', signers: [{ name: 'Pat', email: 'pat@example.test' }] } }, AUTH));
    const e = s.value.envelopeId;
    const tok = tokenFor(dbD, e, 'signer');
    const r = await http(LD.fns.declineEsignEnvelope, { token: tok, reason: 'Going with another roofer' }, '198.51.100.99', 'Decliner/1.0');
    ok('decline accepted', r.statusCode === 200 && r.body.ok === true, JSON.stringify(r.body));
    const ed = dbD._get('esign_envelopes/' + e);
    ok('envelope declined with who / why / where / when', ed.status === 'declined' && ed.declined.reason === 'Going with another roofer' && ed.declined.ip === '198.51.100.99' && ed.declined.ua === 'Decliner/1.0' && ed.declined.at > 0);
    ok('the link is burned as declined', dbD._get('esign_tokens/' + tok).status === 'declined');
    ok('reminders stopped', ed.remindNextAt === undefined);
    ok('estimate mirrors declined', dbD._get('estimates/EST1').signatureStatus === 'declined');
    ok('the rep is told, with the reason', dbD._all('notifications').some((n) => n.type === 'esign_declined' && /another roofer/.test(n.message)));
    const g = await http(LD.fns.getEsignEnvelope, { token: tok });
    ok('opening the link again says declined (not "already signed")', g.statusCode === 410 && g.body.reason === 'declined');
    const sub = await http(LD.fns.submitEsignEnvelope, { token: tok, consent: true, values: { sig_signer: { png: PNG }, date_signer: { text: 'x' } } });
    ok('submitting after declining is refused as declined', sub.statusCode === 409 && sub.body.reason === 'declined');
    const again = await call(LD.fns.sendEsignEnvelope, Object.assign({ data: { envelopeId: e } }, AUTH));
    ok('the rep can send it again after a decline', !again.error && dbD._get('esign_envelopes/' + e).status === 'sent' && !!tokenFor(dbD, e, 'signer'), again.error && again.error.message);
  }

  // ═══════════════════════════════════════════════════════════
  console.log('\nF. Reminders + expiry (esign-reminders.js runSweep)');
  // ═══════════════════════════════════════════════════════════
  {
    const dbR = makeDb(seed());
    const LR = load(dbR, makeStorage());
    const s = await call(LR.fns.sendEstimateEnvelope, Object.assign({ data: { estimateId: 'EST1', signers: [{ name: 'Pat', email: 'pat@example.test' }] } }, AUTH));
    const e = s.value.envelopeId;
    const envRef = 'esign_envelopes/' + e;
    const later = Date.now() + 2 * 86_400_000 + 1000;
    const before = LR.mails.length;
    const r1 = await LR.rem._runSweep(dbR, later);
    ok('a due envelope gets one reminder', r1.reminded === 1, JSON.stringify(r1));
    const m = LR.mails.slice(before);
    ok('the reminder is the same live link, marked as a reminder', m.length === 1 && /^Reminder: please sign/.test(m[0].subject) && m[0].to === 'pat@example.test');
    ok('count 1, next one 2 days later', dbR._get(envRef).reminders.count === 1 && dbR._get(envRef).remindNextAt === later + 2 * 86_400_000);
    await LR.rem._runSweep(dbR, later + 2 * 86_400_000 + 1);
    await LR.rem._runSweep(dbR, later + 4 * 86_400_000 + 2);
    ok('stops after 3 reminders', dbR._get(envRef).reminders.count === 3 && dbR._get(envRef).remindNextAt === undefined);
    const r4 = await LR.rem._runSweep(dbR, later + 6 * 86_400_000 + 3);
    ok('a fourth sweep sends nothing more', r4.reminded === 0);
    const r5 = await LR.rem._runSweep(dbR, Date.now() + 15 * 86_400_000);
    ok('past the 14-day link → envelope expired', r5.expired === 1 && dbR._get(envRef).status === 'expired');
    ok('estimate mirrors expired, rep told to resend', dbR._get('estimates/EST1').signatureStatus === 'expired' && dbR._all('notifications').some((n) => n.type === 'esign_expired'));
  }
  {
    const dbR = makeDb(seed());
    const LR = load(dbR, makeStorage());
    const s = await call(LR.fns.sendEstimateEnvelope, Object.assign({ data: { estimateId: 'EST1', signers: [{ name: 'Pat', email: 'pat@example.test' }], reminders: false } }, AUTH));
    const r = await LR.rem._runSweep(dbR, Date.now() + 3 * 86_400_000);
    ok('a send with reminders:false is never reminded', r.reminded === 0 && dbR._get('esign_envelopes/' + s.value.envelopeId).remindNextAt === undefined);
  }

  // ═══════════════════════════════════════════════════════════
  console.log('\nG. A pre-multi-signer envelope still signs (no signers[], token without signerId)');
  // ═══════════════════════════════════════════════════════════
  {
    const { PDFDocument: P } = require(path.join(FN, 'node_modules', 'pdf-lib'));
    const doc = await P.create(); doc.addPage([612, 792]);
    const bytes = Buffer.from(await doc.save());
    const stG = makeStorage();
    const srcPath = `esign/${UID}/LEAD1/ENVOLD1/source.pdf`;
    stG.files.set(srcPath, bytes);
    const dbG = makeDb(seed({
      'esign_envelopes/ENVOLD1': {
        ownerUid: UID, leadId: 'LEAD1', status: 'sent', title: 'Change Order', sourcePath: srcPath, sourceSha256: sha256(bytes),
        pages: [{ w: 612, h: 792, rotation: 0 }], pageCount: 1, signerName: 'Pat', signerEmail: 'pat@example.test',
        fields: [{ id: 'sig', type: 'signature', page: 0, x: 72, y: 100, w: 200, h: 50, required: true, label: '', role: 'signer' }],
      },
      'esign_tokens/OLDTOKEN0001': { envelopeId: 'ENVOLD1', ownerUid: UID, leadId: 'LEAD1', status: 'pending', expiresAt: { toMillis: () => Date.now() + 86_400_000 } },
    }));
    const LG = load(dbG, stG);
    const g = await http(LG.fns.getEsignEnvelope, { token: 'OLDTOKEN0001' });
    ok('legacy envelope loads with its one field', g.statusCode === 200 && g.body.fields.length === 1 && g.body.signerCount === 1);
    const r = await http(LG.fns.submitEsignEnvelope, { token: 'OLDTOKEN0001', consent: true, signerName: 'Pat', values: { sig: { png: PNG } } });
    ok('legacy envelope signs and completes', r.statusCode === 200 && r.body.complete === true && dbG._get('esign_envelopes/ENVOLD1').status === 'completed', JSON.stringify(r.body));
    ok('legacy envelope gets the certificate + per-signer evidence too',
      ESL.missingEvidence(dbG._get('esign_envelopes/ENVOLD1').signers[0]).length === 0 && !!stG.files.get(`esign/${UID}/LEAD1/ENVOLD1/signed.pdf`));
    ok('legacy consent field still written for old readers', dbG._get('esign_envelopes/ENVOLD1').consent.agreed === true);
  }

  // ═══════════════════════════════════════════════════════════
  console.log('\nI. "Sign on this phone" (the deal page) records ESIGN evidence too');
  // ═══════════════════════════════════════════════════════════
  // The Kentucky-insurance signing path after BoldSign: it recorded the
  // signature and the tier, but not who/where/what device/consent.
  {
    const SIG = 'data:image/png;base64,' + 'A'.repeat(400);
    const PAGE = Buffer.from('<!doctype html><html><body>deal page</body></html>');
    const dbA = makeDb({
      'deal_accept_tokens/DEALTOKEN0001': { dealId: 'DEAL1', ownerUid: UID, leadId: 'LEAD1', status: 'pending', htmlPath: `deal_rooms/${UID}/DEAL1.html`,
        tierPrices: { better: 13000 }, customerName: 'Pat', expiresAt: { toMillis: () => Date.now() + 86_400_000 } },
      'deal_rooms/DEAL1': { userId: UID, status: 'sent', customerName: 'Pat' },
    });
    const stA = makeStorage();
    stA.files.set(`deal_rooms/${UID}/DEAL1.html`, PAGE);
    class HttpsError extends Error { constructor(c, m) { super(m); this.code = c; } }
    const stubs = {
      crypto,
      'firebase-functions/v2/https': { onCall: (o, h) => h, onRequest: (o, h) => h, HttpsError },
      'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {} } },
      'firebase-admin/firestore': {
        Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) }, getFirestore: () => dbA,
        FieldValue: { serverTimestamp: () => ({ __fv: 'serverTimestamp' }), arrayUnion: (...items) => ({ __fv: 'arrayUnion', items }), delete: () => ({ __fv: 'delete' }) },
      },
      'firebase-admin/storage': { getStorage: stA.getStorage },
      './integrations/upstash-ratelimit': { httpRateLimit: async () => true, clientIp: (req) => req.__ip },
      './shared': { callableRateLimit: async () => {}, assertNotViewer: () => {} },
      './deal-install-date': { fillLeadInstallDate: async () => 'skipped' },
      './job-spine': { spineAfterDealAccept: async () => ({}) },
      './deal-view-logic': {}, './estimate-send-logic': {}, './estimate-view-alert': {},
      './deal-accepted-tier': { applyAcceptedTier: async () => ({}) },
      './ky-insurance-law': require(path.join(FN, 'ky-insurance-law.js')),
      './cancel-window': require(path.join(FN, 'cancel-window.js')),
      './deal-packet-logic': require(path.join(FN, 'deal-packet-logic.js')),
      './photo-reencode': { reencodePhoto: async (x) => x },
    };
    const mod = { exports: {} };
    new Function('module', 'exports', 'require', fs.readFileSync(path.join(FN, 'deal-acceptance.js'), 'utf8'))(
      mod, mod.exports, (id) => { if (!(id in stubs)) throw new Error('unstubbed ' + id); return stubs[id]; });
    const r = await http(mod.exports.submitDealAcceptance, { token: 'DEALTOKEN0001', tier: 'better', signature: SIG, consent: true }, '198.51.100.23', 'Mozilla/5.0 (iPhone) DealSigner');
    ok('the acceptance still records', r.statusCode === 200 && dbA._get('deal_rooms/DEAL1').status === 'accepted', JSON.stringify(r.body));
    const ev = dbA._get('deal_rooms/DEAL1').acceptedEvidence || {};
    ok('deal evidence: IP', ev.ip === '198.51.100.23');
    ok('deal evidence: user agent', ev.ua === 'Mozilla/5.0 (iPhone) DealSigner');
    ok('deal evidence: time', ev.at > 0);
    ok('deal evidence: consent + the server\'s own consent words', ev.consent === true && /legal equivalent of my handwritten signature/.test(ev.consentText || ''));
    ok('deal evidence: digest of the signature', ev.signatureSha256 === sha256(Buffer.from(SIG, 'utf8')));
    ok('deal evidence: digest of the page they accepted', ev.pageSha256 === sha256(PAGE) && ev.pagePath === `deal_rooms/${UID}/DEAL1.html`);
    const dealRoom = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'deal-room.js'), 'utf8');
    ok('the deal page asks for that consent and gates ACCEPT on it',
      /CONSENT_TEXT = 'I agree to sign electronically/.test(dealRoom) && /consentBox\.checked/.test(dealRoom) && /consent: !!\(consentBox && consentBox\.checked\)/.test(dealRoom));
  }

  // ═══════════════════════════════════════════════════════════
  console.log('\nJ. Cancellation notice on contract envelopes (#2149) — never twice');
  // ═══════════════════════════════════════════════════════════
  // A rep-uploaded PDF titled as the contract carries no forms of its own:
  // the signed copy gains the Notice of Right to Cancel + two completed FTC
  // forms. The same envelope flagged cancelFormsIncluded (what
  // sendEstimateEnvelope sets — its PDF already has them) gets nothing more.
  {
    const { PDFDocument: P } = require(path.join(FN, 'node_modules', 'pdf-lib'));
    const signOne = async (title, extra) => {
      const doc = await P.create(); doc.addPage([612, 792]);
      const bytes = Buffer.from(await doc.save());
      const stJ = makeStorage();
      const srcPath = `esign/${UID}/LEAD1/ENVJ1/source.pdf`;
      stJ.files.set(srcPath, bytes);
      const dbJ = makeDb(seed({
        'esign_envelopes/ENVJ1': Object.assign({
          ownerUid: UID, leadId: 'LEAD1', status: 'sent', title, sourcePath: srcPath, sourceSha256: sha256(bytes),
          pages: [{ w: 612, h: 792, rotation: 0 }], pageCount: 1, signerName: 'Pat', signerEmail: 'pat@example.test',
          fields: [{ id: 'sig', type: 'signature', page: 0, x: 72, y: 100, w: 200, h: 50, required: true, label: '', role: 'signer' }],
        }, extra || {}),
        'esign_tokens/JTOKEN000001': { envelopeId: 'ENVJ1', ownerUid: UID, leadId: 'LEAD1', status: 'pending', expiresAt: { toMillis: () => Date.now() + 86_400_000 } },
      }));
      const LJ = load(dbJ, stJ);
      const r = await http(LJ.fns.submitEsignEnvelope, { token: 'JTOKEN000001', consent: true, signerName: 'Pat', values: { sig: { png: PNG } } });
      const signed = stJ.files.get(`esign/${UID}/LEAD1/ENVJ1/signed.pdf`);
      return { r, env: dbJ._get('esign_envelopes/ENVJ1'), lead: dbJ._get('leads/LEAD1'), pages: signed ? (await P.load(signed)).getPageCount() : -1, text: signed ? pdfText(signed) : '' };
    };
    const forms = (t) => (t.match(/NOTICE OF CANCELLATION/g) || []).length;
    const c = await signOne('Roofing Contract');
    ok('a contract envelope: signed page + certificate + notice + 2 FTC forms (5 pages)', c.r.statusCode === 200 && c.pages === 5, c.pages + ' ' + JSON.stringify(c.r.body));
    ok('…exactly two completed FTC forms, and the notice', forms(c.text) === 2 && /Notice of Right to Cancel/i.test(c.text), 'forms=' + forms(c.text));
    ok('…cancelBy on the envelope and the lead', /^\d{4}-\d{2}-\d{2}$/.test(c.env.cancelBy || '') && c.lead.cancelBy === c.env.cancelBy, JSON.stringify([c.env.cancelBy, c.lead.cancelBy]));
    const f = await signOne('Roofing Contract — 5 Vine St, Cincinnati, OH 45202', { cancelFormsIncluded: true });
    ok('cancelFormsIncluded: nothing appended (signed page + certificate only)', f.r.statusCode === 200 && f.pages === 2, f.pages);
    ok('cancelFormsIncluded: no second set of forms, no notice', forms(f.text) === 0 && !/Notice of Right to Cancel/i.test(f.text), 'forms=' + forms(f.text));
    const w = await signOne('Manufacturer Warranty Registration');
    ok('a side document is left as signed (no notice, no cancelBy)', w.pages === 2 && !w.env.cancelBy && !w.lead.cancelBy, w.pages);
  }

  // ═══════════════════════════════════════════════════════════
  console.log('\nH. Pure rules (esign-logic.js)');
  // ═══════════════════════════════════════════════════════════
  {
    const throwsMsg = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
    ok('more than 4 signers refused', /At most 4/.test(throwsMsg(() => ESL.sanitizeSignerInput([1, 2, 3, 4, 5].map((i) => ({ name: 'S' + i, email: 's' + i + '@x.test' }))))));
    ok('two signers on one inbox refused', /own email/.test(throwsMsg(() => ESL.sanitizeSignerInput([{ name: 'A', email: 'a@x.test' }, { name: 'B', email: 'A@X.test' }]))));
    ok('emailing needs an email per signer', /needs an email/.test(throwsMsg(() => ESL.sanitizeSignerInput([{ name: 'A', email: '' }], { requireEmail: true }))));
    const twoSigners = [{ id: 'signer', name: 'A' }, { id: 'signer2', name: 'B' }];
    ok('a field assigned to nobody is refused', /not assigned/.test(throwsMsg(() => ESL.validateSignerLayout({ signers: twoSigners, fields: [{ id: 'f1', role: 'signer', required: true }, { id: 'f2', role: 'ghost', required: true }] }))));
    ok('a signer with nothing required is refused', /no required field/.test(throwsMsg(() => ESL.validateSignerLayout({ signers: twoSigners, fields: [{ id: 'f1', role: 'signer', required: true }, { id: 'f2', role: 'signer2', required: false }] }))));
    ok('a single-signer layout owns every field whatever its role', ESL.fieldsForSigner({ signerName: 'A', fields: [{ id: 'f', role: 'whatever' }] }, 'signer').length === 1);
    ok('status mirror vocabulary matches the old webhook\'s',
      ['sent', 'viewed', 'completed', 'declined', 'expired', 'voided'].map(ESL.estimateStatusFor).join() === 'sent,viewed,signed,declined,expired,voided');
  }

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed) { console.log('\n  failures:'); for (const f of fails) console.log('    - ' + f); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('\nFATAL', (e && e.stack) || e); process.exit(1); });
