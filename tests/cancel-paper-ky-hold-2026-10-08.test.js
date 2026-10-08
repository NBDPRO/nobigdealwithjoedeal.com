/**
 * tests/cancel-paper-ky-hold-2026-10-08.test.js — review rounds 3+4 still-open
 * items 2, 4 and 5 (Jo approved all three, 2026-10-08).
 *
 *   A. (item 2, R4 D9) A cancel packet that could not be re-dated at signing.
 *      The stored cancelBy came from the OLD packet (deal acceptance read it
 *      back; remote signing too; the browser read packetCancelBy), the
 *      failure was a log line, and the browser had an empty catch. Now:
 *      cancelBy is always counted from the signing, the re-date is retried
 *      once, and a failure flags the record + the lead (cancelPacketStale)
 *      for the rep. The signature itself is never refused.
 *   B. (item 4, R4 D8) An uploaded contract PDF that already carries the FTC
 *      forms got a second set with a different date: only estimate envelopes
 *      set cancelFormsIncluded. Now createEsignEnvelope / saveEsignFields take
 *      the rep's flag (pre-ticked when the PDF text holds both forms), and a
 *      new Right to Cancel notice is dated today — never the lead's old
 *      contractSignedAt.
 *   C. (item 5) A Kentucky insurance job's pay link is held until the LATER of
 *      the carrier decision + 5 business days and the end of the 3-business-
 *      day right to cancel (lead.cancelBy). It used to look at the decision
 *      only, so a decision recorded long before the signing released the link
 *      inside the cancel window. Every surface goes through payLinkHold.
 *
 * Run: node tests/cancel-paper-ky-hold-2026-10-08.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
function section(t) { console.log('\n' + t); }

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'docs/pro/js');
const FN = path.join(ROOT, 'functions');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const J = require(path.join(JS, 'ky-insurance-law.js'));
const TZ = 'America/New_York';
const todayCancelBy = () => J.cancelBy(new Date(), TZ);
const todayIso = () => J.isoDay(J.toUtcDay(new Date(), TZ));
const MAILING = '4400 Test Pike, Cincinnati, OH 45202';
const OH_ADDR = '902 Ridge Rd, Cincinnati, OH 45230';
const KY_ADDR = '18 Linden Ave, Fort Thomas, KY 41075';

// A packet whose stored inputs cannot be read back: restampCancelPacket then
// returns it UNCHANGED (the real-world "re-date did nothing" failure), still
// dated the day the contract was generated.
const OLD_DAY = '2026-01-05';
const OLD_CANCEL_BY = J.cancelBy(OLD_DAY, TZ);
const OPTS = { timeZone: TZ, sellerName: 'No Big Deal Home Solutions', sellerAddress: MAILING, email: 'info@example.test',
  homeownerName: 'Marcus Reyes', propertyAddress: OH_ADDR, state: 'OH', kyInsurance: false };
const unreadable = (html) => html.replace(/data-nbd-cancel-opts="[^"]*"/g, 'data-nbd-cancel-opts="%E0%A4%A"');
const goodPacket = () => J.cancelPacketHtml(Object.assign({ transactionDate: OLD_DAY }, OPTS));
const pageWith = (packet) => '<!doctype html><html><body><h1>Roofing Contract</h1>' + packet + '</body></html>';

// ── A stubbed Cloud Functions harness (real module code, fake I/O) ──
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
    collection: (c) => ({ add: async (d) => { store.set(c + '/auto' + store.size, d); return { id: 'auto' }; }, doc: (id) => ref(c + '/' + id),
      where: () => ({ where() { return this; }, get: async () => ({ docs: [], size: 0, forEach() {} }) }) }),
    runTransaction: async (fn) => fn({ get: (r) => r.get(), update: (r, d) => { r.update(d); }, set: (r, d, o) => { r.set(d, o); } }),
    _store: store,
  };
}
// failSaves: how many save() calls on `failPath` throw before one succeeds.
function makeStorage(files, failPath, failSaves) {
  const m = new Map(Object.entries(files || {}).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8')]));
  let left = failSaves || 0;
  const st = {
    bucket: () => ({ file: (p) => ({
      download: async () => { if (!m.has(p)) throw new Error('no such object ' + p); return [m.get(p)]; },
      save: async (buf) => {
        st.saves.push(p);
        if (p === failPath && left > 0) { left--; throw new Error('storage unavailable'); }
        m.set(p, Buffer.from(buf));
      },
      getMetadata: async () => [{ size: (m.get(p) || Buffer.alloc(0)).length }],
      getSignedUrl: async () => ['https://signed.example.test/' + p],
    }) }),
    _files: m, saves: [],
  };
  return st;
}
const REAL = ['./ky-insurance-law', '../ky-insurance-law', './cancel-window', '../cancel-window', './cancel-notice-pdf', './job-spine-logic',
  './deal-packet-logic', './lead-artifact-paths', './esign-logic', './await-briefly', './portal-after-signing', 'crypto'];
function loadFn(rel, db, storage, extra) {
  const file = path.join(FN, rel);
  const dir = path.dirname(file);
  class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
  const logs = [];
  const logger = { info() {}, warn: (m) => logs.push(['warn', m]), error: (m) => logs.push(['error', m]) };
  const stubs = Object.assign({
    'firebase-functions/v2/https': { onCall: (o, h) => h, onRequest: (o, h) => h, HttpsError },
    'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'stub' }) },
    'firebase-functions/v2': { logger },
    'firebase-admin/firestore': { getFirestore: () => db, Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) },
      FieldValue: { serverTimestamp: () => ({ __fv: 'ts' }), increment: () => ({ __fv: 'inc' }), arrayUnion: () => ({ __fv: 'union' }), delete: () => ({ __fv: 'del' }) } },
    'firebase-admin/storage': { getStorage: () => storage },
    './integrations/upstash-ratelimit': { httpRateLimit: async () => true, clientIp: () => '203.0.113.9' },
    './shared': { callableRateLimit: async () => {}, assertNotViewer: () => {} },
    '../shared': { assertNotViewer: () => {} },
    './estimate-view-alert': { recordEstimateView: async () => {} },
    './integrations/_shared': { secretOr: (_s, d) => d },
    './resend-guard': { resendRejected: () => false, resendErrorMessage: () => '' },
    './job-spine': { spineAfterRemoteSign: async () => ({}), spineAfterDealAccept: async () => ({}), spineAfterEsign: async () => ({}) },
    './photo-reencode': { reencodePhoto: async (b) => b },
    resend: { Resend: class { constructor() { this.emails = { send: async () => ({ data: { id: 'm1' } }) }; } } },
  }, extra || {});
  const req = (id) => {
    if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
    if (REAL.indexOf(id) !== -1) return require(id.charAt(0) === '.' ? path.join(dir, id) : id);
    throw new Error('unstubbed require(' + id + ')');
  };
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', 'console', 'process', fs.readFileSync(file, 'utf8'))(mod, mod.exports, req, { log() {}, warn() {}, error() {} }, process);
  return { fns: mod.exports, HttpsError, logs };
}
function reqRes(body, extra) {
  const res = { statusCode: 200, body: null, sent: null, headers: {},
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set(k, v) { this.headers[k] = v; return this; },
    send(b) { this.sent = b; return this; }, end() { return this; } };
  return { req: Object.assign({ method: 'POST', body, get: () => 'Mozilla/5.0 (iPhone)', path: '' }, extra || {}), res };
}
const DEAL_STUBS = {
  './deal-install-date': { fillLeadInstallDate: async () => null },
  './deal-view-logic': { isPreviewBot: () => false, shouldNotifyView: () => false, viewMessage: () => ({ title: '', body: '' }) },
  './estimate-send-logic': {},
  './thursday-video-gate': { isNbdTenant: () => false, DEAL_ROOM_INJECT: '', DEAL_ROOM_SCRIPT_PATH: '/pro/js/thursday-video.js' },
  './deal-accepted-tier': { applyAcceptedTier: async () => {} },
};

(async function main() {
  // ════════════════════════════════════════════════════════════════════
  section('A0. signingCancelBy — what a signing records (shared, both copies)');
  // ════════════════════════════════════════════════════════════════════
  {
    ok('the server copy is the browser copy, byte for byte',
      read('docs/pro/js/ky-insurance-law.js').replace(/\r\n/g, '\n') === read('functions/ky-insurance-law.js').replace(/\r\n/g, '\n'));
    ok('signingCancelBy exists', typeof J.signingCancelBy === 'function');
    if (typeof J.signingCancelBy === 'function') {
      const fresh = J.restampCancelPacket(pageWith(goodPacket()), '2026-10-09');
      const r1 = J.signingCancelBy(fresh, '2026-10-09');
      ok('a packet re-dated to the signing day: cancelBy from the signing, not stale', r1.cancelBy === '2026-10-14' && r1.stale === false && r1.signedOn === '2026-10-09', JSON.stringify(r1));
      const stuck = unreadable(pageWith(goodPacket()));
      const r2 = J.signingCancelBy(J.restampCancelPacket(stuck, '2026-10-09'), '2026-10-09');
      ok('a packet the re-date could not move: cancelBy STILL counted from the signing (never the old ' + OLD_CANCEL_BY + '), and stale',
        r2.cancelBy === '2026-10-14' && r2.stale === true, JSON.stringify(r2));
      const r3 = J.signingCancelBy('<p>no packet</p>', '2026-10-09');
      ok('no packet: counted from the signing, not stale', r3.cancelBy === '2026-10-14' && r3.stale === false);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  section('A1. deal acceptance — a re-date that fails is flagged, and cancelBy comes from the signing');
  // ════════════════════════════════════════════════════════════════════
  async function acceptDeal(html, failSaves) {
    const DEAL_PATH = 'deal_rooms/U1/d1.html';
    const db = makeDb({
      'deal_accept_tokens/TOKDEAL00001': { status: 'pending', dealId: 'd1', ownerUid: 'U1', leadId: 'L-OH', htmlPath: DEAL_PATH, tierPrices: { better: 13000 } },
      'deal_rooms/d1': { status: 'sent', userId: 'U1' },
      'leads/L-OH': { userId: 'U1' },
    });
    const st = makeStorage({ [DEAL_PATH]: html }, DEAL_PATH, failSaves);
    const { fns, logs } = loadFn('deal-acceptance.js', db, st, DEAL_STUBS);
    const s = reqRes({ token: 'TOKDEAL00001', tier: 'better', signature: 'data:image/png;base64,' + 'A'.repeat(400), financing: -1 });
    await fns.submitDealAcceptance(s.req, s.res);
    return { res: s.res, deal: db._store.get('deal_rooms/d1'), lead: db._store.get('leads/L-OH'), stored: st._files.get(DEAL_PATH).toString('utf8'), st, logs };
  }
  {
    const a = await acceptDeal(unreadable(pageWith(goodPacket())), 0);
    ok('the homeowner\'s acceptance still succeeds', a.res.statusCode === 200, JSON.stringify(a.res.body));
    ok('deal cancelBy is counted from the signing — NOT the old packet\'s ' + OLD_CANCEL_BY,
      a.deal.cancelBy === todayCancelBy(), 'deal.cancelBy=' + a.deal.cancelBy + ' want ' + todayCancelBy());
    ok('lead cancelBy is counted from the signing too', a.lead.cancelBy === todayCancelBy(), a.lead.cancelBy);
    ok('the deal is flagged: cancelPacketStale + the signing day', a.deal.cancelPacketStale === true && a.deal.cancelPacketSignedOn === todayIso(), JSON.stringify(a.deal));
    ok('the lead is flagged for the rep (source deal_room)', a.lead.cancelPacketStale === true && a.lead.cancelPacketStaleSource === 'deal_room' &&
      a.lead.cancelPacketSignedOn === todayIso(), JSON.stringify(a.lead));
    ok('the failure is loud (an error log, after two attempts)', a.logs.some((l) => l[0] === 'error' && /NOT re-dated/.test(l[1])) &&
      a.logs.filter((l) => l[0] === 'warn' && /attempt [12] of 2/.test(l[1])).length === 2, JSON.stringify(a.logs));
  }
  {
    const a = await acceptDeal(pageWith(goodPacket()), 2);
    ok('the re-dated page could not be STORED (two failed saves): flagged, cancelBy from the signing',
      a.res.statusCode === 200 && a.deal.cancelPacketStale === true && a.lead.cancelPacketStale === true && a.deal.cancelBy === todayCancelBy(),
      JSON.stringify({ deal: a.deal, saves: a.st.saves }));
    ok('…it was tried twice', a.st.saves.filter((p) => p === 'deal_rooms/U1/d1.html').length === 2, a.st.saves.join(','));
  }
  {
    const a = await acceptDeal(pageWith(goodPacket()), 1);
    ok('one failed save, then the retry lands: re-dated, NOT flagged',
      a.deal.cancelPacketStale !== true && a.lead.cancelPacketStale === false && J.packetCancelBy(a.stored) === todayCancelBy() && a.deal.cancelBy === todayCancelBy(),
      JSON.stringify({ deal: a.deal, lead: a.lead, packet: J.packetCancelBy(a.stored) }));
  }

  // ════════════════════════════════════════════════════════════════════
  section('A2. remote signing — same rule on submitSignature');
  // ════════════════════════════════════════════════════════════════════
  function loadDocgen(lead, extraWin) {
    const brand = { legalName: 'No Big Deal Home Solutions', colors: {}, contact: { mailingAddress: MAILING, email: 'info@example.test' } };
    const win = Object.assign({ _brand: () => brand, _leadDoc: lead || null }, extraWin || {});
    win.window = win;
    const noop = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, classList: { add() {}, remove() {} } });
    const sb = { window: win, document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, createElement: noop, head: noop(), body: noop() },
      console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON, Intl, Blob: class { constructor(p) { this.parts = p; } } };
    vm.createContext(sb);
    for (const f of ['ky-insurance-law.js', 'deposit-rule.js', 'estimate-config.js', 'document-generator.js', 'document-generator-templates.js', 'document-generator-library.js']) {
      vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), sb, { filename: f });
    }
    return { DG: win.NBDDocGen, win, sb };
  }
  const SIGNERS = [{ role: 'homeowner', label: 'Homeowner', required: true }, { role: 'rep', label: 'Authorized NBD Representative', required: true }];
  const { DG: DGo } = loadDocgen({ id: 'L-OH', address: OH_ADDR, jobType: 'retail' });
  const ohContract = DGo.renderContract({ leadId: 'L-OH', homeownerName: 'Marcus Reyes', address: OH_ADDR, contractPrice: '$14,520.00',
    contractDate: OLD_DAY, signers: SIGNERS });
  const SIG_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const signIt = (html) => html
    .replace(/<canvas\b[^>]*>\s*<\/canvas>/, '<img src="' + SIG_PNG + '" class="nbd-sig-img">')
    .replace(/data-nbd-sig="homeowner"/, 'data-nbd-sig="homeowner" data-nbd-sig-finalized="1"');
  {
    const stuck = unreadable(ohContract);
    const HTML_PATH = 'documents/U1/L-OH/d-1.html';
    const db = makeDb({
      'leads/L-OH': { userId: 'U1', firstName: 'Marcus', address: OH_ADDR },
      'leads/L-OH/documents/d1': { type: 'contract', typeName: 'Roofing Contract', htmlPath: HTML_PATH },
      'doc_sign_tokens/TOKSTUCK0001': { status: 'pending', leadId: 'L-OH', docId: 'd1', ownerUid: 'U1', htmlPath: HTML_PATH },
    });
    const st = makeStorage({ [HTML_PATH]: stuck });
    const { fns } = loadFn('remote-signing.js', db, st);
    const s = reqRes({ token: 'TOKSTUCK0001', signedHtml: signIt(stuck) });
    await fns.submitSignature(s.req, s.res);
    const doc = db._store.get('leads/L-OH/documents/d1');
    const lead = db._store.get('leads/L-OH');
    ok('the signature is accepted', s.res.statusCode === 200, s.res.statusCode + ' ' + JSON.stringify(s.res.body));
    ok('document cancelBy from the signing — NOT the old packet\'s ' + OLD_CANCEL_BY, doc.cancelBy === todayCancelBy(), 'doc.cancelBy=' + doc.cancelBy);
    ok('document + lead flagged (source remote_sign)', doc.cancelPacketStale === true && lead.cancelPacketStale === true && lead.cancelPacketStaleSource === 'remote_sign',
      JSON.stringify({ doc, lead }));
  }

  // ════════════════════════════════════════════════════════════════════
  section('A3. in-person signing (document-generator.js onPersistFinalized) — real code, stubbed browser');
  // ════════════════════════════════════════════════════════════════════
  {
    const writes = [];
    let opened = null;
    const uploads = [];
    const extraWin = {
      _companyProfileLoaded: true,
      db: {}, storage: {}, _user: { uid: 'U1', email: 'rep@example.test' },
      doc: (_db, ...p) => ({ path: p.join('/') }),
      collection: (_db, ...p) => ({ path: p.join('/') }),
      addDoc: async (c, d) => { writes.push(['add', c.path, d]); return { id: 'DOC1', path: c.path + '/DOC1' }; },
      updateDoc: async (r, d) => { writes.push(['update', r.path, d]); },
      setDoc: async () => {},
      ref: (_s, p) => ({ path: p }),
      uploadBytes: async (r) => { uploads.push(r.path); },
      NBDDocViewer: { open: (o) => { opened = o; } },
    };
    const env = loadDocgen({ id: 'L-OH', address: OH_ADDR, jobType: 'retail' }, extraWin);
    env.DG.getHTML = () => unreadable(ohContract);
    env.DG._recordInPersonSignature = async () => {};
    env.DG._fetchSavedSignatures = async () => null;
    let threw = null;
    try {
      await env.DG.generate('proposal', { leadId: 'L-OH', homeownerName: 'Marcus Reyes', address: OH_ADDR, signers: SIGNERS, customer: { id: 'L-OH', name: 'Marcus Reyes' } });
    } catch (e) { threw = e; }
    ok('the doc viewer opened (harness)', !!opened && typeof opened.onPersistFinalized === 'function', threw && threw.message);
    if (opened && typeof opened.onPersistFinalized === 'function') {
      await opened.onPersistFinalized(signIt(unreadable(ohContract)), [{ role: 'homeowner', label: 'Homeowner' }]);
      const docUpd = writes.find((w) => w[0] === 'update' && /documents\/DOC1$/.test(w[1]) && w[2].status === 'signed');
      const leadUpd = writes.find((w) => w[0] === 'update' && w[1] === 'leads/L-OH' && 'cancelBy' in w[2]);
      ok('in-person: document cancelBy counted from the signing — NOT the old packet\'s ' + OLD_CANCEL_BY,
        !!docUpd && docUpd[2].cancelBy === todayCancelBy(), JSON.stringify(docUpd && docUpd[2]));
      ok('in-person: document flagged cancelPacketStale', !!docUpd && docUpd[2].cancelPacketStale === true, JSON.stringify(docUpd && docUpd[2]));
      ok('in-person: lead gets cancelBy from the signing + the flag (source in_person)',
        !!leadUpd && leadUpd[2].cancelBy === todayCancelBy() && leadUpd[2].cancelPacketStale === true && leadUpd[2].cancelPacketStaleSource === 'in_person',
        JSON.stringify(leadUpd && leadUpd[2]));
    }
  }

  // ════════════════════════════════════════════════════════════════════
  section('B1. an uploaded contract that already carries the FTC forms gets no second set');
  // ════════════════════════════════════════════════════════════════════
  {
    const AD = require(path.join(JS, 'esign-autodetect.js'));
    const items = (s) => s.split(/\n/).map((str) => ({ str }));
    const form = 'NOTICE OF CANCELLATION\n[Enter date of transaction]\nI HEREBY CANCEL THIS TRANSACTION.\n(Date)';
    ok('hasCancelForms: both completed copies in the PDF text → true', typeof AD.hasCancelForms === 'function' &&
      AD.hasCancelForms([items('Roofing contract page 1'), items(form), items(form)]) === true);
    ok('hasCancelForms: a contract that only mentions the notice → false', typeof AD.hasCancelForms === 'function' &&
      AD.hasCancelForms([items('See the attached Notice of Cancellation form. Notice of Cancellation applies.')]) === false);

    // createEsignEnvelope stores the rep's flag; submit then appends nothing.
    const { PDFDocument } = require(require.resolve('pdf-lib', { paths: [FN] }));
    const d = await PDFDocument.create(); d.addPage([612, 792]);
    const pdf = Buffer.from(await d.save());
    const SRC = 'esign/U1/L-OH/ENVUP0001/source.pdf';
    const db = makeDb({ 'leads/L-OH': { userId: 'U1', address: OH_ADDR } });
    const st = makeStorage({ [SRC]: pdf });
    const { fns } = loadFn('esign-envelope.js', db, st, {
      './esign-stamp': { stampPdf: async () => ({}), readPdfGeometry: async () => [{ w: 612, h: 792 }], validateFields: () => {}, appendAuditCertificate: async (b) => b },
      './esign-io': { RESEND_API_KEY: {}, EMAIL_FROM: {}, TTL_DAYS: 14, sha256: () => 'x', sendMail: async () => ({}), notifyRep: async () => {}, syncEstimate: async () => {} },
    });
    await fns.createEsignEnvelope({ auth: { uid: 'U1', token: {} }, data: { leadId: 'L-OH', envelopeId: 'ENVUP0001', sourcePath: SRC, title: 'Roofing Contract', cancelFormsIncluded: true } });
    const env1 = db._store.get('esign_envelopes/ENVUP0001') || {};
    const CW = require(path.join(FN, 'cancel-window.js'));
    ok('createEsignEnvelope keeps the rep\'s "already includes the forms" flag', env1.cancelFormsIncluded === true, JSON.stringify(env1));
    ok('…so the signed contract gets no second, differently dated set', CW.envelopeNeedsCancelNotice(env1) === false);
    await fns.saveEsignFields({ auth: { uid: 'U1', token: {} }, data: { envelopeId: 'ENVUP0001', fields: [], cancelFormsIncluded: false } });
    ok('saveEsignFields lets the rep untick it (then the notice IS appended)', db._store.get('esign_envelopes/ENVUP0001').cancelFormsIncluded === false &&
      CW.envelopeNeedsCancelNotice(db._store.get('esign_envelopes/ENVUP0001')) === true);
    const db2 = makeDb({ 'leads/L-OH': { userId: 'U1' }, 'esign_envelopes/ENVEST0001': { ownerUid: 'U1', status: 'draft', systemFields: [{ id: 's1' }], cancelFormsIncluded: true, pageCount: 1 } });
    const { fns: f2 } = loadFn('esign-envelope.js', db2, makeStorage({}), {
      './esign-stamp': { stampPdf: async () => ({}), readPdfGeometry: async () => [], validateFields: () => {}, appendAuditCertificate: async (b) => b },
      './esign-io': { RESEND_API_KEY: {}, EMAIL_FROM: {}, TTL_DAYS: 14, sha256: () => 'x', sendMail: async () => ({}), notifyRep: async () => {}, syncEstimate: async () => {} },
    });
    await f2.saveEsignFields({ auth: { uid: 'U1', token: {} }, data: { envelopeId: 'ENVEST0001', fields: [], cancelFormsIncluded: false } });
    ok('an estimate envelope (server-built forms) cannot be unticked', db2._store.get('esign_envelopes/ENVEST0001').cancelFormsIncluded === true);
    const html = read('docs/pro/esign-setup.html');
    const js = read('docs/pro/js/esign-setup.js');
    ok('the upload page has the rep checkbox, wired into create + save + reopen',
      /id="suCancelForms"/.test(html) && (js.match(/cancelFormsIncluded: !!\(el\.cancelForms && el\.cancelForms\.checked\)/g) || []).length === 2 &&
      /el\.cancelForms\.checked = d\.cancelFormsIncluded === true/.test(js) && /el\.cancelForms\.checked = await pdfHasCancelForms\(\)/.test(js));
  }

  // ════════════════════════════════════════════════════════════════════
  section('B2. a new Right to Cancel notice is dated today — never the lead\'s old contractSignedAt');
  // ════════════════════════════════════════════════════════════════════
  {
    const brand = { legalName: 'No Big Deal Home Solutions', colors: {}, contact: {} };
    const win = { _brand: () => brand };
    win.window = win;
    const noop = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, classList: { add() {}, remove() {} } });
    const sb = { window: win, document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, createElement: noop, head: noop(), body: noop() },
      console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON };
    for (const f of ['estimate-config.js', 'document-generator.js', 'document-generator-templates.js', 'doc-preflight.js']) {
      vm.runInNewContext(fs.readFileSync(path.join(JS, f), 'utf8'), sb, { filename: f });
    }
    const pf = win.DocPreflight;
    const field = [].concat(...pf.DOC_SCHEMAS.right_to_cancel.sections.map((s) => s.fields)).find((f) => f.key === 'contractDate');
    const d = new Date();
    const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const ctx = (lead) => ({ lead, estimate: {}, photos: [], overrides: {}, depositDropped: [] });
    const v1 = pf._resolveFieldValue(field, ctx({ firstName: 'Jane', contractSignedAt: '2025-04-10T15:00:00Z', contractFiledAt: '2025-04-11' }));
    ok('a lead with an OLD contractSignedAt: the new notice starts from today', v1 === today, 'got ' + v1 + ' want ' + today);
    const v2 = pf._resolveFieldValue(field, ctx({ firstName: 'Jane', cancelPacketStale: true, cancelPacketSignedOn: '2026-10-06', contractSignedAt: '2025-04-10' }));
    ok('the replacement for a flagged signing is dated that signing day', v2 === '2026-10-06', v2);
  }

  // ════════════════════════════════════════════════════════════════════
  section('C. Kentucky insurance: the pay link waits for the decision window AND the cancel window');
  // ════════════════════════════════════════════════════════════════════
  {
    // Decision recorded Sep 1 (its window ran out Sep 9); signed Thu Oct 8 →
    // last day to cancel Tue Oct 13 (Columbus Day skipped).
    const KYL = { address: KY_ADDR, jobType: 'insurance', insuranceCarrier: 'State Farm', claimNumber: 'SF-1', carrierDecisionAt: '2026-09-01', cancelBy: '2026-10-13' };
    const h1 = J.payLinkHold(KYL, {}, '2026-10-12T15:00:00Z', TZ);
    ok('decision window long over, still inside the 3-day cancel window → HELD', h1.held === true, JSON.stringify(h1));
    ok('…release date is the day after the cancel window', h1.releaseDate === 'October 14, 2026', h1.releaseDate);
    ok('the last day to cancel itself (11:30 pm ET) → still held', J.payLinkHold(KYL, {}, '2026-10-14T03:30:00Z', TZ).held === true);
    ok('the day after → released', J.payLinkHold(KYL, {}, '2026-10-14T15:00:00Z', TZ).held === false);
    const noStamp = Object.assign({}, KYL, { cancelBy: undefined, contractSignedAt: '2026-10-08T16:00:00Z' });
    ok('no cancelBy stamp but a contractSignedAt → held through ITS cancel window', J.payLinkHold(noStamp, {}, '2026-10-13T15:00:00Z', TZ).held === true &&
      J.payLinkHold(noStamp, {}, '2026-10-14T15:00:00Z', TZ).held === false);
    const lateDecision = Object.assign({}, KYL, { carrierDecisionAt: '2026-10-12' });
    const h2 = J.payLinkHold(lateDecision, {}, '2026-10-16T15:00:00Z', TZ);
    ok('a decision AFTER the signing still rules when it ends later (released after Oct 19)', h2.held === true && h2.releaseDate === 'October 20, 2026', JSON.stringify(h2));
    ok('no decision recorded → held (unchanged)', J.payLinkHold(Object.assign({}, KYL, { carrierDecisionAt: null }), {}, '2026-11-30', TZ).held === true);
    ok('a Kentucky CASH job inside its cancel window is not held (deposits at signing unchanged)',
      J.payLinkHold({ address: KY_ADDR, jobType: 'retail', cancelBy: '2026-10-13' }, {}, '2026-10-09', TZ).held === false);
    ok('an Ohio insurance job is never held', J.payLinkHold({ address: OH_ADDR, jobType: 'insurance', cancelBy: '2026-10-13' }, {}, '2026-10-09', TZ).held === false);
    ok('emergency work is never held', J.payLinkHold(KYL, { emergencyServices: true }, '2026-10-12', TZ).held === false);

    // Every surface asks payLinkHold.
    const inv = { leadId: 'L-KY', total: 5000, balanceDue: 5000, status: 'sent', stripePaymentLink: 'https://pay.example.test/x', dueDate: '2026-10-09' };
    ok('payUrlUnlessHeld (portal, customer page, invoice send) → no link in the cancel window',
      J.payUrlUnlessHeld(KYL, inv, '2026-10-12T15:00:00Z', TZ) === '' && J.payUrlUnlessHeld(KYL, inv, '2026-10-14T15:00:00Z', TZ) === inv.stripePaymentLink);
    ok('invoiceOverdue: never overdue while held', J.invoiceOverdue(inv, KYL, '2026-10-12T15:00:00Z', TZ).overdue === false);
    const Gate = require(path.join(FN, 'ky-pay-link-gate-logic.js'));
    const g = await Gate.kyPayLinkGate({ invoice: inv, readLead: async () => KYL, readProfile: async () => ({}), now: Date.parse('2026-10-12T15:00:00Z') });
    ok('createStripePaymentLink\'s gate refuses to mint in the cancel window', g.held === true && g.reason === 'ky_window', JSON.stringify(g));
    const IC = require(path.join(FN, 'invoice-charge.js'));
    const card = IC.portalBalanceCard(inv, J.payUrlUnlessHeld(KYL, inv, '2026-10-12T15:00:00Z', TZ), J.payLinkHold(KYL, inv, '2026-10-12T15:00:00Z', TZ));
    ok('portal Balance card: "held", $0 due, no link, release date shown', card.kind === 'held' && card.amountCents === 0 && card.stripePaymentLink === null &&
      card.releaseDate === 'October 14, 2026', JSON.stringify(card));
    const MPL = require(path.join(FN, 'money-paper-logic.js'));
    const sInv = Object.assign({}, inv, { stripeHostedUrl: 'https://invoice.stripe.example.test/i/1', lineItems: [{ description: 'Roof', amount: 5000 }] });
    ok('the filed invoice PDF prints no pay link / QR inside the cancel window, and does after it',
      MPL.invoicePayload(sInv, KYL, 'NBD-1', Date.parse('2026-10-12T15:00:00Z')).payUrl === null &&
      MPL.invoicePayload(sInv, KYL, 'NBD-1', Date.parse('2026-10-14T15:00:00Z')).payUrl === sInv.stripeHostedUrl);
    // Server portal + invoice reminder + customer page pass the whole lead doc.
    const portalSrc = read('functions/portal.js');
    ok('portal.js: the pay link and the card both go through the hold with the lead doc',
      /KyLaw\.payUrlUnlessHeld\(lead, _unpaidInvoice/.test(portalSrc) && /KyLaw\.payLinkHold\(lead, _unpaidInvoice/.test(portalSrc));

    // KY wording: the hold copy names no claim outcome.
    const portalJs = read('docs/pro/js/portal.js');
    const heldCopy = portalJs.slice(portalJs.indexOf('const steps = held'), portalJs.indexOf(": [\n", portalJs.indexOf('const steps = held')) + 400);
    ok('portal held card says "Nothing is due yet" and names the right to cancel',
      /Nothing is due yet/.test(portalJs) && /3-business-day right to cancel this contract has ended/.test(portalJs));
    const words = J.MSG.payLinkHeld + ' ' + heldCopy;
    ok('hold copy: no claim-outcome or claim-handling wording', !/\b(we|we'll|we will)\s+(handle|negotiate|fight)|get (it|your claim) (approved|paid)|guarantee/i.test(words), words);
    ok('rep message names the cancel window too', /3-business-day right to cancel/.test(J.MSG.payLinkHeld));
  }

  console.log('\n' + '─'.repeat(50));
  console.log('cancel-paper-ky-hold-2026-10-08: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
