/**
 * tests/sweep-lows-crm-2026-11-17.test.js — three low findings from the
 * 2026-11-17 sweep, each RUN for real (vm / stubbed requires), not grepped.
 *
 * #9  E-sign source PDF. storage.rules let the owner overwrite
 *     esign/{uid}/…/source.pdf after send, and getEsignEnvelope served
 *     whatever bytes were there without checking env.sourceSha256 (only
 *     submitEsignEnvelope did). A replaced source showed the homeowner a
 *     different document, then 409'd at Sign. Now: the esign prefix is
 *     create-only, and getEsignEnvelope refuses (409) on a digest mismatch.
 *
 * #16 Doc pre-flight warranty picker. renderWarrantyTier hard-coded NBD's
 *     five labor-year tiers (incl. "20-Year Labor + HailGuard") for every
 *     tenant, while the fill step prints the tenant's OWN warrantyLines
 *     sentence. Another company's rep now sees its own enabled tiers, names
 *     and sentence; NBD's ladder is unchanged byte-for-byte.
 *
 * #17 Customer-page stage button. "→ Move to <label>" went into innerHTML,
 *     and the label is tenant config. Both sites now set textContent.
 *
 * Run: node tests/sweep-lows-crm-2026-11-17.test.js   (no deps, no emulator)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ═══════════════════════════════════════════════════════════════
// #9 getEsignEnvelope — functions/esign-envelope.js with every require stubbed
// ═══════════════════════════════════════════════════════════════
function makeDb(seed) {
  const store = new Map(Object.entries(seed));
  const ref = (p) => ({
    id: p.split('/').pop(),
    get: async () => ({ exists: store.has(p), data: () => store.get(p) }),
    set: async (patch) => { store.set(p, Object.assign({}, store.get(p) || {}, patch)); },
    update: async (patch) => { store.set(p, Object.assign({}, store.get(p) || {}, patch)); },
  });
  return { doc: ref, _store: store };
}

function loadEsign(db, storedBytes) {
  class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
  const noop = { info() {}, warn() {}, error() {} };
  const stubs = {
    crypto,
    'firebase-functions/v2/https': {
      onCall: (o, h) => async (r) => h(r),
      onRequest: (o, h) => async (req, res) => h(req, res),
      HttpsError,
    },
    'firebase-functions/params': { defineSecret: (name) => ({ name, value: () => 'stub' }) },
    'firebase-functions/v2': { logger: noop },
    'firebase-admin/firestore': {
      Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) },
      getFirestore: () => db,
      FieldValue: { serverTimestamp: () => ({}), arrayUnion: (...items) => ({ items }), delete: () => ({}) },
    },
    'firebase-admin/storage': {
      getStorage: () => ({ bucket: () => ({ file: () => ({ download: async () => [storedBytes], save: async () => {} }) }) }),
    },
    './integrations/upstash-ratelimit': { httpRateLimit: async () => true, clientIp: () => '203.0.113.9' },
    './shared': { callableRateLimit: async () => {}, assertNotViewer: () => {} },
    './esign-stamp': {
      stampPdf: async () => ({ bytes: Buffer.from('%PDF-SIGNED'), missingRequired: [] }),
      readPdfGeometry: async () => [{ w: 612, h: 792 }],
      validateFields: () => {},
      appendAuditCertificate: async (b) => ({ bytes: b, pagesAdded: 1 }),
      FIELD_TYPES: ['signature', 'initials', 'date', 'text', 'checkbox'],
    },
    './esign-logic': require(path.join(ROOT, 'functions', 'esign-logic.js')),
    './integrations/_shared': { secretOr: (_s, d) => d },
    './messaging-controls': require('./lib/messaging-controls-stub'),
    './resend-guard': { resendRejected: () => false, resendErrorMessage: () => 'rejected' },
    './job-spine': { spineAfterEsign: async () => ({ skipped: 'stub' }) },
    './job-spine-logic': { envelopeIsContract: () => false },
    './cancel-window': { loadPacketOpts: async () => ({}), stampLeadCancelBy: async () => false, envelopeNeedsCancelNotice: () => false, SELLER_NAME_REQUIRED_MSG: 'x' },
  };
  const req = (id) => {
    if (id === './esign-io' && !stubs[id]) {
      const io = { exports: {} };
      new Function('module', 'exports', 'require', 'process', read('functions/esign-io.js'))(io, io.exports, req, { env: {} });
      stubs[id] = io.exports;
    }
    if (!Object.prototype.hasOwnProperty.call(stubs, id)) throw new Error('unstubbed require(' + id + ')');
    return stubs[id];
  };
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', 'console', read('functions/esign-envelope.js'))(
    mod, mod.exports, req, { log() {}, warn() {}, error() {} });
  return mod.exports;
}

async function getEnvelope(envExtra, storedBytes) {
  const db = makeDb({
    'esign_tokens/TOKEN12345': { status: 'pending', envelopeId: 'ENV1', signerId: 's1' },
    'esign_envelopes/ENV1': Object.assign({
      ownerUid: 'UID1', leadId: 'LEAD1', status: 'sent', title: 'Contract',
      sourcePath: 'esign/UID1/LEAD1/ENV1/source.pdf',
      signers: [{ id: 's1', name: 'Pat', email: 'pat@example.com', status: 'pending' }],
      fields: [{ id: 'sig', type: 'signature', page: 0, required: true, signerId: 's1' }],
    }, envExtra),
  });
  const fns = loadEsign(db, storedBytes);
  const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; }, set() { return this; } };
  await fns.getEsignEnvelope({ method: 'POST', body: { token: 'TOKEN12345' }, get: () => 'UA' }, res);
  return { res, db };
}

// ═══════════════════════════════════════════════════════════════
// #16 doc-preflight — the real DocPreflight open → submit in a fake DOM
// ═══════════════════════════════════════════════════════════════
function makeSandbox(extraWin) {
  function el(tag) {
    return {
      tagName: String(tag || 'div').toUpperCase(), id: '', innerHTML: '', textContent: '', value: '',
      style: {}, dataset: {}, disabled: false, firstChild: null,
      classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
      appendChild(ch) { return ch; }, setAttribute() {}, getAttribute() { return null; },
      addEventListener() {}, removeEventListener() {}, querySelector() { return null; },
      querySelectorAll() { return []; }, closest() { return null; }, focus() {}, setSelectionRange() {}, remove() {},
    };
  }
  const document = {
    head: el('head'), body: el('body'), createElement: el,
    getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
  const store = {};
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const win = Object.assign({ localStorage, document }, extraWin || {});
  win.window = win;
  const sandbox = {
    window: win, document, localStorage, navigator: { userAgent: 'node' },
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise,
    CSS: { escape: (s) => String(s) }, location: { origin: 'https://example.test' },
  };
  vm.createContext(sandbox);
  return { win, sandbox };
}

function docStack(extraWin) {
  const env = makeSandbox(Object.assign({ _brand: () => ({ legalName: 'No Big Deal Home Solutions', colors: {}, contact: {} }) }, extraWin));
  ['estimate-config.js', 'tenant-rules.js', 'deposit-rule.js', 'customer-estimate-rows.js',
    'document-generator.js', 'document-generator-templates.js', 'doc-preflight.js'].forEach((f) =>
    vm.runInContext(read('docs/pro/js/' + f), env.sandbox, { filename: f }));
  env.toasts = [];
  env.win.showToast = (m) => env.toasts.push(m);
  return env;
}

function throughPreflight(env, type, est) {
  const w = env.win;
  w._leadDoc = { firstName: 'Jane', lastName: 'Smith', address: '123 Main St, Cincinnati, OH 45202', phone: '5135550100', email: 'j@example.test', scopeOfWork: 'Work as quoted.' };
  w._customerEstimates = [est];
  let captured = null;
  const dg = w.NBDDocGen;
  const realGenerate = dg.generate;
  dg.generate = (t, data) => { captured = data; };
  let modalHtml = '';
  const origCreate = env.sandbox.document.createElement;
  env.sandbox.document.createElement = (tag) => {
    const e = origCreate(tag);
    let inner = '';
    Object.defineProperty(e, 'innerHTML', { get() { return inner; }, set(v) { inner = v; if (String(v).indexOf('dpf-') !== -1) modalHtml = String(v); } });
    return e;
  };
  const done = () => { dg.generate = realGenerate; env.sandbox.document.createElement = origCreate; return { data: captured, modalHtml }; };
  w.DocPreflight.open(type, null);
  if (!w.DocPreflight._state.open) return Promise.resolve(done());
  w.DocPreflight._state.softAck = true;
  return Promise.resolve(w.DocPreflight.submit()).then(done);
}

const tierAttrs = (html) => [...String(html).matchAll(/data-warranty-tier="([^"]*)"/g)].map((m) => m[1]);

// The ladder NBD saw before this change, rebuilt here as the byte-for-byte
// expectation (doc-preflight.js renderWarrantyTier, origin/main 2026-11-17).
function nbdLadder(cur) {
  const tiers = [
    { id: 'economy', name: 'Economy', tag: '1-Year Labor', desc: '1-year workmanship (labor) warranty. Shingle manufacturer\'s standard limited warranty; no system warranty.' },
    { id: 'good', name: 'Good', tag: '5-Year Labor', desc: '5-year written workmanship (labor) warranty, non-transferable. Manufacturer warranty per package.' },
    { id: 'better', name: 'Better', tag: '10-Year Labor', desc: '10-year written workmanship (labor) warranty, transferable to 1 subsequent owner. Manufacturer warranty per package.' },
    { id: 'best', name: 'Best', tag: '20-Year Labor', desc: '20-year written workmanship (labor) warranty, fully transferable + annual inspection. Manufacturer warranty per package.' },
    { id: 'beyond', name: 'Beyond', tag: '20-Year Labor + HailGuard', desc: '20-year written workmanship (labor) warranty, fully transferable + annual inspection. TAMKO HailGuard shingles with TAMKO\'s hail warranty.' },
  ];
  // esc() turns ' into &#39; in the attribute value only; names/tags/descs
  // went in raw, exactly as the original did.
  return '<div class="dpf-warranty-grid">' + tiers.map((t) =>
    '<div class="dpf-warranty-card' + (t.id === cur ? ' selected' : '') + '" data-warranty-field="warrantyTier" data-warranty-tier="' + t.id + '">' +
    '<div class="dpf-warranty-name">' + t.name + '</div>' +
    '<div class="dpf-warranty-tag">' + t.tag + '</div>' +
    '<div class="dpf-warranty-desc">' + t.desc + '</div>' +
    '</div>').join('') + '</div>';
}

// ═══════════════════════════════════════════════════════════════
// #17 customer-bootstrap.module.js — the two stage-button blocks, lifted and run
// ═══════════════════════════════════════════════════════════════
const BOOT = read('docs/pro/js/customer-bootstrap.module.js').replace(/\r\n/g, '\n');

function fakeButton() {
  const b = { style: {}, disabled: true, _text: '', htmlWrites: [] };
  Object.defineProperty(b, 'textContent', { get() { return this._text; }, set(v) { this._text = String(v); } });
  Object.defineProperty(b, 'innerHTML', {
    get() { return this._text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
    set(v) { this.htmlWrites.push(String(v)); this._text = String(v).replace(/<[^>]*>/g, ''); },
  });
  return b;
}

(async function main() {
  console.log('\nsweep-lows-crm-2026-11-17\n');

  // ─────────────────────────────────────────────────────────────
  console.log('#9 getEsignEnvelope serves only the document that was hashed');
  {
    const original = Buffer.from('%PDF-1.7 the contract the rep placed fields on');
    const swapped = Buffer.from('%PDF-1.7 a DIFFERENT document uploaded over source.pdf');

    const { res, db } = await getEnvelope({ sourceSha256: sha256(original) }, swapped);
    ok('a replaced source.pdf is refused with 409', res.statusCode === 409, res.statusCode + ' ' + JSON.stringify(res.body));
    ok('…and no PDF bytes are sent to the signer', !(res.body && res.body.pdf), Object.keys(res.body || {}).join(','));
    ok('…with a clear, actionable message', res.body && /changed since it was sent/i.test(res.body.error || ''), res.body && res.body.error);
    ok('…and it is not recorded as a view', !(db._store.get('esign_envelopes/ENV1').viewedBy));

    const good = await getEnvelope({ sourceSha256: sha256(original) }, original);
    ok('control: the hashed source is served (200 + pdf)',
      good.res.statusCode === 200 && good.res.body && good.res.body.pdf === original.toString('base64'),
      good.res.statusCode + ' ' + JSON.stringify(good.res.body && good.res.body.error));

    const legacy = await getEnvelope({}, swapped);
    ok('control: an envelope with no recorded digest is served as before', legacy.res.statusCode === 200 && !!legacy.res.body.pdf);
  }

  console.log('\n#9 storage.rules esign prefix is create-only');
  {
    const rules = read('storage.rules').replace(/\r\n/g, '\n');
    const at = rules.indexOf('match /esign/{uid}/{allPaths=**}');
    const end = at < 0 ? -1 : rules.indexOf('\n    }\n', at);
    const block = at < 0 || end < 0 ? '' : rules.slice(at, end);
    ok('found the esign match block', block.length > 0);
    ok('esign/ allows create (on a missing object) and never write/update',
      /^(?![\s\S]*allow\s+(?:write|update)\b)[\s\S]*allow create: if ownerWrites\(uid\)\s*&& resource == null/.test(block), block);
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n#16 doc pre-flight warranty picker follows the tenant');
  const EST = { id: 'E1', tier: 'better', tierName: 'Preferred', lineItems: [{ description: 'Roof replacement', qty: 1, unit: 'job', rate: 12000, amount: 12000 }], total: 12000, grandTotal: 12000 };
  {
    const nbd = docStack({});
    const r = await throughPreflight(nbd, 'contract', Object.assign({}, EST));
    ok('NBD: the modal rendered', !!r.modalHtml, 'no modal html');
    ok('NBD: the five-tier labor-year ladder is unchanged byte-for-byte', r.modalHtml.indexOf(nbdLadder('better')) !== -1,
      'warranty grid: ' + (r.modalHtml.match(/<div class="dpf-warranty-grid">[\s\S]*?<\/div><\/div><\/div>/) || [''])[0].slice(0, 300));
  }
  {
    const tenant = docStack({
      _userClaims: { companyId: 'TENANT1' },
      _companyProfile: {
        brand: { legalName: 'Acme Roofing LLC' },
        businessRules: { tiers: {
          enabled: ['good', 'better', 'best'],
          labels: { good: 'Silver', better: 'Gold <b>Plus</b>', best: 'Platinum' },
          warranty: { better: 'Acme 10-year workmanship warranty on all labor.' },
        } },
      },
    });
    ok('tenant: tenant-rules sees a non-platform company', tenant.win.NBDTenantRules.isPlatformTenant() === false);
    const r = await throughPreflight(tenant, 'contract', Object.assign({}, EST));
    const tiers = tierAttrs(r.modalHtml);
    ok('tenant: only the company\'s enabled tiers are offered', JSON.stringify(tiers) === '["good","better","best"]', JSON.stringify(tiers));
    ok('tenant: no NBD labor-year ladder or TAMKO HailGuard', r.modalHtml.indexOf('HailGuard') === -1 && r.modalHtml.indexOf('-Year Labor') === -1);
    ok('tenant: the company\'s own tier names, escaped', r.modalHtml.indexOf('Gold &lt;b&gt;Plus&lt;/b&gt;') !== -1 && r.modalHtml.indexOf('Gold <b>') === -1);
    ok('tenant: the card shows the sentence the document prints', r.modalHtml.indexOf('Acme 10-year workmanship warranty on all labor.') !== -1);
    ok('tenant: a tier with no sentence says so', /data-warranty-tier="good">[\s\S]*?No workmanship warranty/.test(r.modalHtml));
    ok('tenant: the estimate\'s tier is the selected card', /dpf-warranty-card selected"[^>]*data-warranty-tier="better"/.test(r.modalHtml));
    ok('tenant: the contract prints that same sentence',
      r.data && r.data.warranty === 'Acme 10-year workmanship warranty on all labor.',
      r.data ? JSON.stringify(r.data.warranty) : 'not generated: ' + tenant.toasts.join(' | '));

    const off = await throughPreflight(tenant, 'contract', Object.assign({}, EST, { tier: 'beyond', tierName: 'Beyond' }));
    ok('tenant: a disabled tier on the estimate is not shown as a picked card', !/dpf-warranty-card selected"[^>]*data-warranty-tier=/.test(off.modalHtml));
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n#17 stage button label is text, never markup');
  const EVIL = { key: 'x', label: '<img src=x onerror=alert(1)>Signed' };
  {
    const fnAt = BOOT.indexOf('function _applyStageOnPage(');
    const fnEnd = fnAt < 0 ? -1 : BOOT.indexOf('\n}\n', fnAt);
    ok('found _applyStageOnPage', fnAt >= 0 && fnEnd > fnAt);
    const btn = fakeButton();
    const ctx = { window: {}, document: { getElementById: (id) => (id === 'stageProgressBtn' ? btn : null) }, _nextStageFor: () => EVIL, String };
    vm.createContext(ctx);
    vm.runInContext(BOOT.slice(fnAt, fnEnd + 2) + '\n_applyStageOnPage({ stage: "a" }, "b", "B");', ctx);
    ok('after a move: the button text is the literal label', btn.textContent === '→ Move to ' + EVIL.label, btn.textContent);
    ok('after a move: no markup was written', btn.htmlWrites.length === 0, JSON.stringify(btn.htmlWrites));
  }
  {
    const at = BOOT.indexOf('const _next = _nextStageFor(lead);');
    const end = at < 0 ? -1 : BOOT.indexOf('\n    }\n', at);
    ok('found the page-load stage button block', at >= 0 && end > at);
    const btn = fakeButton();
    const ctx = { lead: { stage: 'a' }, document: { getElementById: (id) => (id === 'stageProgressBtn' ? btn : null) }, _nextStageFor: () => EVIL };
    vm.createContext(ctx);
    vm.runInContext('(function () {' + BOOT.slice(at, end + 6) + '})();', ctx);
    ok('on page load: the button text is the literal label', btn.textContent === '→ Move to ' + EVIL.label, btn.textContent);
    ok('on page load: no markup was written', btn.htmlWrites.length === 0, JSON.stringify(btn.htmlWrites));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
