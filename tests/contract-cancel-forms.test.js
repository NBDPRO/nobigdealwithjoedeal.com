/**
 * tests/contract-cancel-forms.test.js — the 3-day right to cancel on every
 * contract signed in the app (2026-10-04).
 *
 * THE BUG: only the server-rendered contract PDF attached the FTC Notice of
 * Cancellation. A contract signed in the app — in person on the phone, on the
 * deal page's "Sign on this phone", through a remote signing link, or as an
 * e-sign envelope — carried no notice and no forms. The FTC Cooling-Off Rule
 * (16 CFR 429.1) and the Ohio / Kentucky home solicitation laws want the
 * buyer to get the notice and two completed cancellation forms AT THE TIME OF
 * SALE.
 *
 *   A. cancelBy business-day math (ky-insurance-law.js, both copies) across
 *      weekends, federal holidays and a late-night signing.
 *   B. The packet itself — notice, FTC statement, 2 completed FTC forms;
 *      + the KRS 367.624 notices and 2 KY forms on a Kentucky insurance job;
 *      re-dating to the signing day; stripping for the integrity compare.
 *   C. Every signing path's OUTPUT (real code, stubbed I/O):
 *        1. the generated contract + signable proposal (in-person signing in
 *           the doc viewer, and the HTML a remote link serves)
 *        2. the deal page ("Sign on this phone" / the homeowner link)
 *        3. remote signing — createSignRequest refuses a contract without the
 *           packet; getSignDocument serves it dated today; submitSignature
 *           stores it re-rendered from the ORIGINAL, dated the signing day,
 *           and records cancelBy on the document and the lead
 *        4. deal acceptance — the stored deal page is re-dated, cancelBy on
 *           the deal and the lead
 *        5. e-sign envelope — the notice + 2 FTC forms as PDF pages (+ 2 KY
 *           forms on a KY insurance job); which envelopes get them — never
 *           one already carrying its forms (cancelFormsIncluded, #2166).
 *           The signing run itself: tests/esign-gaps-2026-10-04.test.js J.
 *        (BoldSign was retired by #2166; Send for signature is an envelope.)
 *   D. The stage-move warning: inside the window, not after it, not for a
 *      stage that starts no work.
 *
 * Run: node tests/contract-cancel-forms.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

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
const JF = require(path.join(FN, 'ky-insurance-law.js'));
const count = (s, re) => (String(s).match(re) || []).length;
const MAILING = '4400 Test Pike, Cincinnati, OH 45202';
const OH_ADDR = '902 Ridge Rd, Cincinnati, OH 45230';
const KY_ADDR = '18 Linden Ave, Fort Thomas, KY 41075';
const TZ = 'America/New_York';
const todayCancelBy = () => J.cancelBy(new Date(), TZ);

function text(html) {
  return String(html).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');
}
// The packet is complete: notice + statement + exactly two FTC forms.
function packetComplete(html) {
  return J.hasCancelPacket(html) && /Notice of Right to Cancel/.test(html) &&
    /data-nbd-statutory="ftc-429-1-a"/.test(html) && count(html, /data-nbd-noc="ftc"/g) === 2;
}

(async function main() {
  // ════════════════════════════════════════════════════════════════════
  section('A. cancelBy — 3 business days (16 CFR 429.0: every day but Sunday and federal holidays)');
  // ════════════════════════════════════════════════════════════════════
  const CASES = [
    ['2026-10-02', '2026-10-06', 'Fri → Tue (Sat counts, Sun skipped)'],
    ['2026-10-03', '2026-10-07', 'Sat → Wed (Sun skipped)'],
    ['2026-10-05', '2026-10-08', 'Mon → Thu'],
    ['2026-10-09', '2026-10-14', 'Fri → Wed (Sun + Columbus Day Mon Oct 12 skipped)'],
    ['2026-11-25', '2026-11-30', 'Wed before Thanksgiving → Mon (Thanksgiving + Sun skipped)'],
    ['2026-07-02', '2026-07-08', 'Thu → Wed (Jul 3 observed + Jul 4 + Sun skipped)'],
    ['2026-12-24', '2026-12-29', 'Christmas Eve → Tue (Christmas + Sun skipped)'],
    ['2026-12-30', '2027-01-04', 'Dec 30 → Mon Jan 4 (New Year + Sun skipped, across the year)'],
  ];
  for (const [d, want, why] of CASES) {
    ok('cancelBy(' + d + ') = ' + want + ' — ' + why, J.cancelBy(d, TZ) === want, J.cancelBy(d, TZ));
  }
  ok('a 10:30 pm signing in Kentucky counts from THAT day, not the UTC date (Oct 2 → Oct 6)',
    J.cancelBy('2026-10-03T02:30:00Z', TZ) === '2026-10-06', J.cancelBy('2026-10-03T02:30:00Z', TZ));
  ok('the server copy computes the same days', CASES.every(([d, w]) => JF.cancelBy(d, TZ) === w));
  ok('the server copy is the browser copy, byte for byte',
    read('docs/pro/js/ky-insurance-law.js').replace(/\r\n/g, '\n') === read('functions/ky-insurance-law.js').replace(/\r\n/g, '\n'));
  ok('the packet\'s printed deadline is the same day the record stores',
    /data-nbd-cancel-by="2026-10-14"/.test(J.cancelPacketHtml({ transactionDate: '2026-10-09', timeZone: TZ })) &&
    text(J.cancelPacketHtml({ transactionDate: '2026-10-09', timeZone: TZ })).includes('NOT LATER THAN MIDNIGHT OF October 14, 2026'));

  // ════════════════════════════════════════════════════════════════════
  section('B. the packet — notice, statement, forms; KY insurance adds the 5-day forms');
  // ════════════════════════════════════════════════════════════════════
  const OPTS = { timeZone: TZ, sellerName: 'No Big Deal Home Solutions', sellerAddress: MAILING, email: 'info@example.test',
    homeownerName: 'Marcus Reyes', propertyAddress: OH_ADDR, state: 'OH', kyInsurance: false };
  const ohP = J.cancelPacketHtml(Object.assign({ transactionDate: '2026-10-05' }, OPTS));
  ok('OH: notice + FTC statement + exactly two FTC forms', packetComplete(ohP));
  ok('OH: the forms are COMPLETED — date, seller, address, deadline',
    text(ohP).includes('October 5, 2026') && text(ohP).includes('No Big Deal Home Solutions') && text(ohP).includes(MAILING) &&
    text(ohP).includes('NOT LATER THAN MIDNIGHT OF October 8, 2026'));
  ok('OH: names Ohio\'s Home Solicitation Sales Act', text(ohP).includes('Ohio Revised Code 1345.21 to 1345.28'));
  ok('OH: the FTC form text is verbatim 16 CFR 429.1(b)', J.FTC_FORM_PARAS.every((p) => text(ohP).includes(p)));
  ok('OH: no Kentucky forms or notices', !/data-nbd-noc="ky"/.test(ohP) && !/ky-367-624-3/.test(ohP));
  const kyP = J.cancelPacketHtml(Object.assign({ transactionDate: '2026-10-05' }, OPTS, { state: 'KY', propertyAddress: KY_ADDR, kyInsurance: true }));
  ok('KY insurance: two FTC forms AND two KRS 367.624(4) forms', count(kyP, /data-nbd-noc="ftc"/g) === 2 && count(kyP, /data-nbd-noc="ky"/g) === 2);
  ok('KY insurance: the KRS 367.624(3) notices', /data-nbd-statutory="ky-367-624-3"/.test(kyP) && text(kyP).includes(J.KY_NOTICE_CANCEL));
  ok('KY insurance: names Kentucky\'s home solicitation law', text(kyP).includes('Kentucky Revised Statutes 367.410 to 367.460'));
  const kyCash = J.cancelPacketHtml(Object.assign({ transactionDate: '2026-10-05' }, OPTS, { state: 'KY', propertyAddress: KY_ADDR, kyInsurance: false }));
  ok('KY cash job: the FTC forms, but not the insurance-only 5-day forms', packetComplete(kyCash) && !/data-nbd-noc="ky"/.test(kyCash));
  const restamped = J.restampCancelPacket('<html><body>contract' + ohP + '</body></html>', '2026-10-07');
  ok('re-dated to the signing day: generated Mon Oct 5, signed Wed Oct 7 → last day Sat Oct 10',
    J.packetCancelBy(restamped) === '2026-10-10' && text(restamped).includes('October 7, 2026') && !text(restamped).includes('October 5, 2026'), J.packetCancelBy(restamped));
  ok('…keeping the seller, homeowner and address it was made with',
    text(restamped).includes(MAILING) && text(restamped).includes('Marcus Reyes') && packetComplete(restamped));
  ok('HTML without a packet is left alone', J.restampCancelPacket('<p>x</p>', '2026-10-07') === '<p>x</p>');
  ok('stripCancelPacket removes it entirely', J.stripCancelPacket('a' + ohP + 'b') === 'ab');
  ok('re-dating twice is stable (no nested or duplicated packet)',
    count(J.restampCancelPacket(restamped, '2026-10-09'), /<!--nbd-cancel-packet:start-->/g) === 1 &&
    J.packetCancelBy(J.restampCancelPacket(restamped, '2026-10-09')) === '2026-10-14');
  ok('no style="…" attribute in the packet wrapper (classes only — the CRM inline-style ratchet)',
    !/class="nbd-cxl"[^>]*style=/.test(ohP));

  // ════════════════════════════════════════════════════════════════════
  section('C1. the generated contract + signable proposal (in-person signing; what a remote link serves)');
  // ════════════════════════════════════════════════════════════════════
  function loadDocgen(lead) {
    const brand = { legalName: 'No Big Deal Home Solutions', colors: {}, contact: { mailingAddress: MAILING, email: 'info@example.test' } };
    const win = { _brand: () => brand, _leadDoc: lead || null };
    win.window = win;
    const noop = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, classList: { add() {}, remove() {} } });
    const sb = { window: win, document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, createElement: noop, head: noop(), body: noop() },
      console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON, Intl };
    vm.createContext(sb);
    for (const f of ['ky-insurance-law.js', 'deposit-rule.js', 'estimate-config.js', 'document-generator.js', 'document-generator-templates.js', 'document-generator-library.js']) {
      vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), sb, { filename: f });
    }
    return win.NBDDocGen;
  }
  const SIGNERS = [{ role: 'homeowner', label: 'Homeowner', required: true }, { role: 'rep', label: 'Authorized NBD Representative', required: true }];
  const ohLead = { id: 'L-OH', address: OH_ADDR, jobType: 'retail' };
  const DGo = loadDocgen(ohLead);
  const contractData = (addr, extra) => Object.assign({ leadId: 'L-OH', homeownerName: 'Marcus Reyes', address: addr, contractPrice: '$14,520.00',
    contractDate: '2026-10-05', signers: SIGNERS }, extra || {});
  const ohContract = DGo.renderContract(contractData(OH_ADDR));
  ok('OH cash contract: notice + FTC statement + two completed FTC forms', packetComplete(ohContract), text(ohContract).slice(-400));
  const execAt = ohContract.indexOf('Contract Execution');
  const sigAt = ohContract.indexOf('data-nbd-sig=');
  ok('the 429.1(a) statement sits beside the buyer\'s signature (inside Contract Execution, before the pad)',
    ohContract.indexOf('data-nbd-statutory="ftc-429-1-a"') > execAt && ohContract.indexOf('data-nbd-statutory="ftc-429-1-a"') < sigAt, [execAt, sigAt].join(','));
  ok('…with the homeowner\'s acknowledgment of the notice and both forms',
    text(ohContract.slice(execAt, sigAt)).includes('acknowledges receiving the attached Notice of Right to Cancel and two completed copies'));
  ok('the notice + forms come AFTER the signatures', ohContract.indexOf('<!--nbd-cancel-packet:start-->') > sigAt);
  ok('the packet is completed with the Company Profile mailing address and the contract date',
    text(ohContract).includes(MAILING) && J.packetCancelBy(ohContract) === '2026-10-08');
  const ohProposal = DGo.renderProposal(Object.assign(contractData(OH_ADDR), { totalPrice: '$14,520.00' }));
  ok('signable proposal: the same notice + forms + statement', packetComplete(ohProposal) &&
    ohProposal.indexOf('data-nbd-statutory="ftc-429-1-a"') < ohProposal.indexOf('data-nbd-sig='));
  const kyLead = { id: 'L-KY', address: KY_ADDR, jobType: 'insurance', claimNumber: 'SF-1' };
  const DGk = loadDocgen(kyLead);
  const kyContract = DGk.renderContract(contractData(KY_ADDR, { leadId: 'L-KY', claimNumber: 'SF-1', insuranceCompany: 'State Farm' }));
  ok('KY insurance contract: FTC forms + the KY 5-day forms, each exactly twice (no duplicate KY page)',
    packetComplete(kyContract) && count(kyContract, /data-nbd-noc="ky"/g) === 2, count(kyContract, /data-nbd-noc="ky"/g));
  ok('KY insurance contract: the KRS 367.624(3) notices print ONCE (before the signatures, not again in the packet)',
    count(kyContract, /data-nbd-statutory="ky-367-624-3"/g) === 1, count(kyContract, /data-nbd-statutory="ky-367-624-3"/g));
  ok('KY insurance contract: KRS 367.624(3) notices still before the signatures',
    kyContract.indexOf('data-nbd-statutory="ky-367-624-3"') > 0 && kyContract.indexOf('data-nbd-statutory="ky-367-624-3"') < kyContract.indexOf('data-nbd-sig='));
  // In-person signing re-dates on finalize (viewer + generator both call it).
  const viewerSrc = read('docs/pro/js/nbd-doc-viewer.js');
  const fin = viewerSrc.slice(viewerSrc.indexOf('reply.html = stripPhoneLayout(reply.html);'), viewerSrc.indexOf('currentContext.html = reply.html;'));
  ok('doc viewer: the signed copy is re-dated to the signing day BEFORE it is kept / printed / stored',
    /restampCancelPacket\(reply\.html, new Date\(\)\)/.test(fin));
  const genSrc = read('docs/pro/js/document-generator.js');
  const opf = genSrc.slice(genSrc.indexOf('onPersistFinalized: async'), genSrc.indexOf('onPersistFinalized: async') + 4000);
  ok('in-person signing records cancelBy on the document AND the lead, from the signed packet',
    /packetCancelBy\(signedHtml\)/.test(opf) && /cancelBy: _cancelBy/.test(opf) && /'leads', _leadIdEarly\), \{ cancelBy: _cancelBy \}/.test(opf));

  // ════════════════════════════════════════════════════════════════════
  section('C2. the deal page — "Sign on this phone" and the homeowner link');
  // ════════════════════════════════════════════════════════════════════
  function loadCB() {
    const win = { addEventListener() {}, _user: null };
    win.window = win;
    const doc = { getElementById: () => null, addEventListener() {}, querySelector: () => null };
    win.document = doc;
    const c = { window: win, document: doc, console: { log() {}, warn() {}, error() {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      setTimeout, clearTimeout, navigator: {}, Date, Math, JSON, Intl };
    vm.createContext(c);
    vm.runInContext(read('docs/pro/js/ky-insurance-law.js'), c);
    vm.runInContext(read('docs/pro/js/estimate-config.js'), c);
    win._brand = () => ({ legalName: 'No Big Deal Home Solutions', contact: { phone: '(859) 420-7382', email: 'info@example.test', mailingAddress: MAILING } });
    vm.runInContext(read('docs/pro/js/close-board.js'), c);
    return win.CloseBoard;
  }
  const tierOf = (p) => ({ price: p, description: '', lineItems: [] });
  const CB = loadCB();
  const dealOH = { id: 'd1', customerName: 'Pat Doe', address: '1 Test St, Milford, OH 45150', repName: 'Joe', repEmail: 'jd@example.test',
    tiers: { good: tierOf(11000), better: tierOf(13000) } };
  const dealHtml = CB.generatePageHTML(dealOH);
  ok('OH cash deal page: notice + FTC statement + two completed FTC forms', packetComplete(dealHtml));
  ok('the statement is above the signature pad; the notice + forms below it',
    dealHtml.indexOf('data-nbd-statutory="ftc-429-1-a"') < dealHtml.indexOf('id="sigCanvas"') &&
    dealHtml.indexOf('<!--nbd-cancel-packet:start-->') > dealHtml.indexOf('id="sigCanvas"'));
  ok('…completed with the Company Profile mailing address', text(dealHtml.slice(dealHtml.indexOf('<!--nbd-cancel-packet:start-->'))).includes(MAILING));
  const dealKY = Object.assign({}, dealOH, { address: KY_ADDR, insuranceClaim: true, insuranceCarrier: 'State Farm' });
  const dealKYHtml = CB.generatePageHTML(dealKY);
  ok('KY insurance deal page: FTC forms + KY 5-day forms, each exactly twice', packetComplete(dealKYHtml) && count(dealKYHtml, /data-nbd-noc="ky"/g) === 2,
    count(dealKYHtml, /data-nbd-noc="ky"/g));
  ok('KY insurance deal page: the KRS 367.624(3) notices print once (above the pad)',
    count(dealKYHtml, /data-nbd-statutory="ky-367-624-3"/g) === 1, count(dealKYHtml, /data-nbd-statutory="ky-367-624-3"/g));

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
  function makeStorage(files) {
    const m = new Map(Object.entries(files || {}).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8')]));
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
  const REAL = ['./ky-insurance-law', '../ky-insurance-law', './cancel-window', '../cancel-window', './cancel-notice-pdf', './job-spine-logic', './deal-packet-logic', 'crypto'];
  function loadFn(rel, db, storage, extra) {
    const file = path.join(FN, rel);
    const dir = path.dirname(file);
    class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
    const logger = { info() {}, warn() {}, error() {} };
    const stubs = Object.assign({
      'firebase-functions/v2/https': { onCall: (o, h) => h, onRequest: (o, h) => h, HttpsError },
      'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'stub' }) },
      'firebase-functions/v2': { logger },
      'firebase-admin/firestore': { getFirestore: () => db, Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) },
        FieldValue: { serverTimestamp: () => ({ __fv: 'ts' }), increment: () => ({ __fv: 'inc' }), arrayUnion: () => ({ __fv: 'union' }) } },
      'firebase-admin/storage': { getStorage: () => storage },
      './integrations/upstash-ratelimit': { httpRateLimit: async () => true, clientIp: () => '203.0.113.9' },
      './shared': { callableRateLimit: async () => {}, assertNotViewer: () => {} },
      '../shared': { assertNotViewer: () => {} },
      './estimate-view-alert': { recordEstimateView: async () => {} },
      './integrations/_shared': { secretOr: (_s, d) => d },
      './resend-guard': { resendRejected: () => false, resendErrorMessage: () => '' },
      './job-spine': { spineAfterRemoteSign: async () => ({}), spineAfterDealAccept: async () => ({}), spineAfterEsign: async () => ({}) },
      './photo-reencode': { reencodePhoto: async (b) => b },   // #2139 deal photos (sharp) — not under test here
      resend: { Resend: class { constructor() { this.emails = { send: async () => ({ data: { id: 'm1' } }) }; } } },
    }, extra || {});
    const req = (id) => {
      if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
      if (REAL.indexOf(id) !== -1) return require(id.charAt(0) === '.' ? path.join(dir, id) : id);
      throw new Error('unstubbed require(' + id + ')');
    };
    const mod = { exports: {} };
    new Function('module', 'exports', 'require', 'console', 'process', fs.readFileSync(file, 'utf8'))(mod, mod.exports, req, { log() {}, warn() {}, error() {} }, process);
    return { fns: mod.exports, HttpsError };
  }
  function reqRes(body, extra) {
    const res = { statusCode: 200, body: null, sent: null, headers: {},
      status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set(k, v) { this.headers[k] = v; return this; },
      send(b) { this.sent = b; return this; }, end() { return this; } };
    return { req: Object.assign({ method: 'POST', body, get: () => 'Mozilla/5.0 (iPhone)', path: '' }, extra || {}), res };
  }
  const signIt = (html) => html.replace(/data-nbd-sig="homeowner"/, 'data-nbd-sig="homeowner" data-nbd-sig-finalized="1"');

  // ════════════════════════════════════════════════════════════════════
  section('C3. remote signing — createSignRequest / getSignDocument / submitSignature');
  // ════════════════════════════════════════════════════════════════════
  {
    const OLD = ohContract.replace(/<!--nbd-cancel-packet:start-->[\s\S]*?<!--nbd-cancel-packet:end-->/, '');
    const HTML_PATH = 'documents/U1/L-OH/d-1.html';
    const OLD_PATH = 'documents/U1/L-OH/d-old.html';
    const seed = () => ({
      'leads/L-OH': { userId: 'U1', firstName: 'Marcus', address: OH_ADDR },
      'leads/L-OH/documents/d1': { type: 'contract', typeName: 'Roofing Contract', htmlPath: HTML_PATH },
      'leads/L-OH/documents/dold': { type: 'contract', typeName: 'Roofing Contract', htmlPath: OLD_PATH },
    });
    const db = makeDb(seed());
    const st = makeStorage({ [HTML_PATH]: ohContract, [OLD_PATH]: OLD });
    const { fns } = loadFn('remote-signing.js', db, st);
    const call = async (docId) => { try { return { v: await fns.createSignRequest({ auth: { uid: 'U1', token: {} }, data: { leadId: 'L-OH', docId, signerEmail: 'marcus@example.test' } }) }; } catch (e) { return { e }; } };
    const old = await call('dold');
    ok('createSignRequest REFUSES a contract generated without the notice + forms (with the fix in the message)',
      old.e && old.e.code === 'failed-precondition' && /Generate the contract again/.test(old.e.message), old.e && old.e.message);
    const good = await call('d1');
    ok('…and sends one that carries them', !good.e && good.v && /^[A-Z0-9]+$/.test(String(good.v.token || good.v.signLink || 'X').replace(/^.*token=/, '')), good.e && good.e.message);
    const tokenKey = [...db._store.keys()].find((k) => k.startsWith('doc_sign_tokens/'));
    const token = tokenKey.split('/')[1];
    const g = reqRes({ token });
    await fns.getSignDocument(g.req, g.res);
    const served = g.res.body && g.res.body.html;
    ok('getSignDocument serves the notice + forms dated TODAY (the day the homeowner reads and signs)',
      packetComplete(served) && J.packetCancelBy(served) === todayCancelBy(), served && J.packetCancelBy(served));
    // The homeowner signs; a tamper tries to change the deadline inside the packet.
    const tampered = signIt(served).replace(/NOT LATER THAN MIDNIGHT OF ([^<]+)/g, 'NOT LATER THAN MIDNIGHT OF January 1, 2020');
    const s = reqRes({ token, signedHtml: tampered });
    await fns.submitSignature(s.req, s.res);
    ok('submitSignature accepts the signed contract', s.res.statusCode === 200 && s.res.body && s.res.body.ok, JSON.stringify(s.res.body));
    const record = st._files.get(HTML_PATH).toString('utf8');
    ok('the stored record carries the notice + both completed forms', packetComplete(record));
    ok('…re-rendered from the ORIGINAL, dated the signing day (the signer\'s edit inside it never reaches the record)',
      J.packetCancelBy(record) === todayCancelBy() && !record.includes('January 1, 2020'));
    ok('…and it is the signed copy', /data-nbd-sig-finalized="1"/.test(record));
    ok('cancelBy recorded on the document', db._store.get('leads/L-OH/documents/d1').cancelBy === todayCancelBy(), JSON.stringify(db._store.get('leads/L-OH/documents/d1')));
    ok('cancelBy recorded on the lead (the customer page reads it)', db._store.get('leads/L-OH').cancelBy === todayCancelBy());
    // A signer who strips the packet out entirely gets it put back.
    const db2 = makeDb(Object.assign(seed(), { 'doc_sign_tokens/TOKSTRIP0001': { status: 'pending', leadId: 'L-OH', docId: 'd1', ownerUid: 'U1', htmlPath: HTML_PATH } }));
    const st2 = makeStorage({ [HTML_PATH]: ohContract });
    const { fns: f2 } = loadFn('remote-signing.js', db2, st2);
    const s2 = reqRes({ token: 'TOKSTRIP0001', signedHtml: J.stripCancelPacket(signIt(ohContract)) });
    await f2.submitSignature(s2.req, s2.res);
    ok('a signed copy with the packet removed is stored WITH it (put back from the original)',
      s2.res.statusCode === 200 && packetComplete(st2._files.get(HTML_PATH).toString('utf8')), s2.res.statusCode + ' ' + JSON.stringify(s2.res.body));
  }

  // ════════════════════════════════════════════════════════════════════
  section('C4. deal acceptance — the stored deal page is re-dated, cancelBy on the deal + lead');
  // ════════════════════════════════════════════════════════════════════
  {
    const DEAL_PATH = 'deal_rooms/U1/d1.html';
    const generated = CB.generatePageHTML(Object.assign({}, dealOH)).replace(/data-nbd-cancel-by="[^"]*"/, 'data-nbd-cancel-by="2026-01-01"');
    const db = makeDb({
      'deal_accept_tokens/TOKDEAL00001': { status: 'pending', dealId: 'd1', ownerUid: 'U1', leadId: 'L-OH', htmlPath: DEAL_PATH, tierPrices: { better: 13000 } },
      'deal_rooms/d1': { status: 'sent', userId: 'U1' },
      'leads/L-OH': { userId: 'U1' },
    });
    const st = makeStorage({ [DEAL_PATH]: generated });
    const { fns } = loadFn('deal-acceptance.js', db, st, {
      './deal-install-date': { fillLeadInstallDate: async () => null },
      './deal-view-logic': { isPreviewBot: () => false, shouldNotifyView: () => false, viewMessage: () => ({ title: '', body: '' }) },
      './estimate-send-logic': {},
      './deal-accepted-tier': { applyAcceptedTier: async () => {} },
    });
    const g = reqRes(null, { method: 'GET', path: '/deal/TOKDEAL00001' });
    await fns.getDealRoom(g.req, g.res);
    ok('getDealRoom serves the notice + forms dated today', packetComplete(g.res.sent) && J.packetCancelBy(g.res.sent) === todayCancelBy(),
      g.res.sent && J.packetCancelBy(g.res.sent));
    const sig = 'data:image/png;base64,' + 'A'.repeat(400);
    const s = reqRes({ token: 'TOKDEAL00001', tier: 'better', signature: sig, financing: -1 });
    await fns.submitDealAcceptance(s.req, s.res);
    ok('submitDealAcceptance accepts', s.res.statusCode === 200, JSON.stringify(s.res.body));
    const stored = st._files.get(DEAL_PATH).toString('utf8');
    ok('the stored deal page (the signed record) carries the notice + forms dated the acceptance day',
      packetComplete(stored) && J.packetCancelBy(stored) === todayCancelBy(), J.packetCancelBy(stored));
    ok('cancelBy on the deal', db._store.get('deal_rooms/d1').cancelBy === todayCancelBy(), JSON.stringify(db._store.get('deal_rooms/d1')));
    ok('cancelBy on the lead', db._store.get('leads/L-OH').cancelBy === todayCancelBy());
  }

  // ════════════════════════════════════════════════════════════════════
  section('C5. e-sign envelope — the signed PDF gains the notice + forms');
  // ════════════════════════════════════════════════════════════════════
  const { PDFDocument } = require(require.resolve('pdf-lib', { paths: [FN] }));
  async function onePagePdf() { const d = await PDFDocument.create(); d.addPage([612, 792]); return Buffer.from(await d.save()); }
  // Text the PDF draws (pdf-lib writes standard-font text as hex strings in
  // flate-compressed content streams).
  function pdfText(bytes) {
    const s = Buffer.from(bytes).toString('latin1');
    let out = '';
    const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g; let m;
    while ((m = re.exec(s))) {
      let body;
      try { body = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch (_) { body = m[1]; }
      body.replace(/<([0-9A-Fa-f]+)>\s*Tj/g, (_x, hex) => { out += Buffer.from(hex, 'hex').toString('latin1') + ' '; return ''; });
    }
    return out.replace(/\s+/g, ' ');
  }
  const appendCancelNotice = require(path.join(FN, 'cancel-notice-pdf.js')).appendCancelNotice;
  {
    const r = await appendCancelNotice(await onePagePdf(), Object.assign({ transactionDate: '2026-10-09' }, OPTS));
    const t = pdfText(r.bytes);
    ok('OH: notice page + FTC copy 1 + FTC copy 2 appended (3 pages)', r.pagesAdded === 3, r.pagesAdded);
    ok('OH: the notice and BOTH forms are completed (seller, address, date, deadline)',
      count(t, /NOTICE OF CANCELLATION/g) === 2 && t.includes(MAILING) && count(t, /NOT LATER THAN MIDNIGHT OF October 14, 2026/g) === 2 && t.includes('October 9, 2026'), t.slice(0, 600));
    ok('OH: the 429.1(a) statement + the 429.1(b) form text', t.includes('You, the buyer, may cancel this transaction at any time prior to midnight') &&
      t.includes('within TEN BUSINESS DAYS following receipt by the seller'));
    ok('OH: cancelBy returned for the record', r.cancelBy === '2026-10-14');
    const k = await appendCancelNotice(await onePagePdf(), Object.assign({ transactionDate: '2026-10-09' }, OPTS, { state: 'KY', kyInsurance: true }));
    const kt = pdfText(k.bytes);
    ok('KY insurance: + the two KRS 367.624(4) forms (5 pages)', k.pagesAdded === 5 && count(kt, /NOTICE OF CANCELLATION/g) === 4, k.pagesAdded);
    ok('KY insurance: the 5-day form body + the (3) notices', kt.includes('before midnight of the fifth business day after you have received the notice') &&
      kt.includes('in violation of KRS 304.20-105'));
  }
  {
    // Which signed envelopes get these pages appended (submitEsignEnvelope).
    // The full signing run — real handler, real stamper, the estimate
    // envelope that already carries its forms — is in
    // tests/esign-gaps-2026-10-04.test.js section J.
    const CW = require(path.join(FN, 'cancel-window.js'));
    ok('a rep-uploaded envelope titled as the contract gets the notice', CW.envelopeNeedsCancelNotice({ title: 'Roofing Contract' }) === true);
    ok('a side document (warranty registration / change order) does not', CW.envelopeNeedsCancelNotice({ title: 'Manufacturer Warranty Registration' }) === false &&
      CW.envelopeNeedsCancelNotice({ title: 'Change Order' }) === false);
    // #2166: Send for signature builds "Roofing Contract — <address>" WITH the
    // two completed FTC forms and sets cancelFormsIncluded — a second set
    // must never be appended.
    ok('an estimate envelope whose PDF already has the forms (cancelFormsIncluded) does NOT get a second set',
      CW.envelopeNeedsCancelNotice({ title: 'Roofing Contract — 5 Vine St, Cincinnati, OH 45202', cancelFormsIncluded: true }) === false);
    ok('no envelope → no notice', CW.envelopeNeedsCancelNotice(null) === false);
  }

  // ════════════════════════════════════════════════════════════════════
  section('D. stage moves that start work warn inside the window — and not after it');
  // ════════════════════════════════════════════════════════════════════
  const lead = { cancelBy: '2026-10-06' };
  const at = (iso) => new Date(iso);
  ok('Materials Ordered on the last day (Oct 6, 8 pm ET) warns',
    /still in the 3-day cancellation window/.test(J.workStartWarning(lead, 'materials_ordered', at('2026-10-07T00:00:00Z'), TZ)));
  ok('Crew Scheduled the day after signing warns', /October 6, 2026/.test(J.workStartWarning(lead, 'crew_scheduled', at('2026-10-03T15:00:00Z'), TZ)));
  ok('after the window (Oct 7, 1 am ET) — no warning', J.workStartWarning(lead, 'materials_ordered', at('2026-10-07T05:00:00Z'), TZ) === '');
  ok('a stage that starts no work (Job Created) — no warning', J.workStartWarning(lead, 'job_created', at('2026-10-03T15:00:00Z'), TZ) === '');
  ok('no contract signed in the app (no cancelBy) — no warning', J.workStartWarning({}, 'materials_ordered', at('2026-10-03T15:00:00Z'), TZ) === '');
  ok('cancelWindowOpen: open through the last day, closed after',
    J.cancelWindowOpen('2026-10-06', at('2026-10-07T03:59:00Z'), TZ) === true && J.cancelWindowOpen('2026-10-06', at('2026-10-07T04:01:00Z'), TZ) === false);
  ok('the chip text', J.cancelByText('2026-10-06') === 'October 6, 2026');
  // Warn, never block: both stage-move paths keep moving.
  const cb = read('docs/pro/js/customer-bootstrap.module.js');
  const ps = cb.slice(cb.indexOf('window.progressStage = async function'), cb.indexOf('window.progressStage = async function') + 3000);
  ok('customer page: the warning is IN the move confirm (and the move still runs on OK)',
    /workStartWarning\(/.test(ps) && /Move customer to "\$\{label\}" stage anyway\?/.test(ps));
  const pl = read('docs/pro/js/crm-pipeline.js');
  const mc = pl.slice(pl.indexOf('// ─── 3-day cancellation window (2026-10-04)'), pl.indexOf('// ─── Warranty-claim guard ───', pl.indexOf('// ─── 3-day cancellation window (2026-10-04)')));
  ok('kanban: a warning toast, no return (never blocks the move)', /workStartWarning\(/.test(mc) && /showToast\(/.test(mc) && !/\breturn\b/.test(mc));

  console.log('\n' + '─'.repeat(50));
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFAILED:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
