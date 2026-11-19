/**
 * paper-cert-signers-2026-11-18.test.js - the signing-ease lane (flag docClauseSetV1, per person, default OFF):
 *   1. paper certification (Q49, Q63): an uploaded paper-signed document records type, link to the original,
 *      signing date, optional witness and a distinct status, and counts as the signed contract only after
 *      the server-written attestation (attestWetSigned).
 *   2. signable documents (Q51)   3. co-owners (Q52)   4. in-person consent tick (Q62)
 * Run: node tests/paper-cert-signers-2026-11-18.test.js   (needs functions/node_modules)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
module.paths.unshift(path.join(FN, 'node_modules'));
const kit = require('./lib/doc-evidence-kit');
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; if (process.env.V1_VERBOSE) console.log('  ok ' + name); }
  else { failed++; fails.push(name); console.log('  FAIL ' + name + (detail !== undefined ? ' - ' + detail : '')); }
}
function section(name) { console.log('\n' + name); }
async function rejects(fn) { try { await fn(); return null; } catch (e) { return e; } }

(async () => {
  // ───────────────────────── 1. paper certification: the server callable ─────────────────────────
  section('1. attestWetSigned (server)');
  let L = null;
  try { L = require(path.join(FN, 'paper-cert-logic.js')); } catch (e) { ok('paper-cert-logic.js loads', false, e.message); }
  if (L) {
    const seed = () => ({
      'leads/L1': { userId: 'REP', companyId: 'CO', firstName: 'Dana', lastName: 'W' },
      'leads/L2': { userId: 'OTHER', companyId: 'CO2' },
      'leads/L1/documents/ORIG': { type: 'contract', status: 'draft', htmlPath: 'documents/REP/L1/d-1.html' },
      'leads/L1/documents/PAPER': { source: 'signed_upload', status: 'wet_signed_uploaded', type: 'image/jpeg', name: 'scan.jpg', url: 'https://x.test/scan.jpg',
        wetSignedDocType: 'contract', originalDocId: 'ORIG', wetSignedOn: '2026-11-17', witnessName: 'Pat Neighbor', uploadedBy: 'REP' },
      'leads/L1/documents/COC': { source: 'signed_upload', status: 'wet_signed_uploaded', type: 'application/pdf', wetSignedDocType: 'certificate_of_completion', wetSignedOn: '2026-11-17', uploadedBy: 'REP' },
      'leads/L1/documents/OTHERDOC': { source: 'signed_upload', status: 'wet_signed_uploaded', type: 'application/pdf', wetSignedDocType: 'other', wetSignedOn: '2026-11-17', uploadedBy: 'REP' },
      'leads/L1/documents/FUTURE': { source: 'signed_upload', status: 'wet_signed_uploaded', type: 'application/pdf', wetSignedDocType: 'contract', wetSignedOn: '2099-01-01', uploadedBy: 'REP' },
      'leads/L1/documents/BADTYPE': { source: 'signed_upload', status: 'wet_signed_uploaded', type: 'application/pdf', wetSignedDocType: 'wire_transfer', wetSignedOn: '2026-11-17', uploadedBy: 'REP' },
      'leads/L1/documents/LEGACY': { source: 'signed_upload', status: 'signed', type: 'image/jpeg', name: 'old.jpg' },
      'leads/L1/documents/GEN': { type: 'contract', status: 'sent' },
    });
    const ORIG_HTML = Buffer.from('<html><body>The contract</body></html>');
    const mk = (over) => {
      const db = kit.makeDb(seed());
      const events = [];
      const deps = Object.assign({
        flagOn: async () => true,
        readBytes: async (p) => { if (p === 'documents/REP/L1/d-1.html') return ORIG_HTML; throw new Error('nope'); },
        toTimestamp: (ms) => ({ toMillis: () => ms }),
        now: () => Date.parse('2026-11-18T15:00:00Z'),
        facts: { ip: '203.0.113.9', ipSource: 'socket', ua: 'UA' },
        fileSigned: async (d, info) => {
          const filedField = { contract: 'contractFiledAt', certificate_of_completion: 'cocFiledAt' }[info.docType] || null;
          if (!filedField) return { filedField: null };
          await d.doc('leads/' + info.leadId).set({ [filedField]: 'ISO' }, { merge: true });
          events.push(Object.assign({ filedField }, info)); return { filedField };
        },
      }, over || {});
      return { db, events, deps };
    };
    const REP = { uid: 'REP', token: { companyId: 'CO', name: 'Rep Name' } };

    ok('exports the status, the types and the attestation sentence',
      L.WET_STATUS === 'wet_signed_uploaded' && Array.isArray(L.PAPER_DOC_TYPES) && L.PAPER_DOC_TYPES.indexOf('contract') !== -1 && typeof L.ATTEST_TEXT === 'string' && L.ATTEST_TEXT.length > 20);

    { const { db, deps } = mk({ flagOn: async () => false });
      const e = await rejects(() => L.attestWetSigned(db, REP, { leadId: 'L1', docId: 'PAPER' }, deps));
      ok('flag off: refused (failed-precondition)', !!e && e.code === 'failed-precondition', e && e.code);
      ok('flag off: the row is untouched', db._get('leads/L1/documents/PAPER').status === 'wet_signed_uploaded' && !db._get('leads/L1/documents/PAPER').wetSignedAttestation); }
    { const { db, deps } = mk();
      const e = await rejects(() => L.attestWetSigned(db, { uid: 'STRANGER', token: { companyId: 'ELSE' } }, { leadId: 'L1', docId: 'PAPER' }, deps));
      ok('another company cannot attest (permission-denied)', !!e && e.code === 'permission-denied', e && e.code);
      const e2 = await rejects(() => L.attestWetSigned(db, REP, { leadId: 'L2', docId: 'PAPER' }, deps));
      ok('a lead of another company is refused', !!e2 && e2.code === 'permission-denied', e2 && e2.code); }
    { const { db, deps } = mk();
      const r = await L.attestWetSigned(db, { uid: 'STAFF', token: { companyId: 'CO', name: 'Staff Person' } }, { leadId: 'L1', docId: 'PAPER' }, deps);
      ok('same-company staff can attest', r && r.ok === true, JSON.stringify(r)); }
    { const { db, deps, events } = mk();
      const r = await L.attestWetSigned(db, REP, { leadId: 'L1', docId: 'PAPER', witnessName: 'Chris Witness' }, deps);
      const row = db._get('leads/L1/documents/PAPER');
      ok('attest: ok', r && r.ok === true && r.filedField === 'contractFiledAt', JSON.stringify(r));
      ok('attest: status becomes signed', row.status === 'signed');
      ok('attest: attestation {byUid,name,at,text} written by the server',
        row.wetSignedAttestation && row.wetSignedAttestation.byUid === 'REP' && row.wetSignedAttestation.name === 'Rep Name'
        && row.wetSignedAttestation.at === Date.parse('2026-11-18T15:00:00Z') && row.wetSignedAttestation.text === L.ATTEST_TEXT, JSON.stringify(row.wetSignedAttestation));
      ok('attest: the signing date is the row\'s own signing date, not the attest time',
        row.signedAt && new Date(row.signedAt.toMillis()).toISOString().slice(0, 10) === '2026-11-17');
      ok('attest: witness recorded (the call\'s overrides the row\'s)', row.wetSignedEvidence && row.wetSignedEvidence.witnessName === 'Chris Witness');
      ok('attest: link to the original and its digest recorded', row.wetSignedEvidence.originalDocId === 'ORIG'
        && row.wetSignedEvidence.originalSha256 === kit.sha256(ORIG_HTML) && row.wetSignedEvidence.originalShortDigest === kit.sha256(ORIG_HTML).slice(0, 12), JSON.stringify(row.wetSignedEvidence));
      ok('attest: server-observed ip and user agent recorded', row.wetSignedEvidence.ip === '203.0.113.9' && row.wetSignedEvidence.ua === 'UA');
      ok('attest: the contract is filed through the spine adapter with the original\'s id (counts once)',
        events.length === 1 && events[0].docType === 'contract' && events[0].sourceDocId === 'ORIG' && events[0].filedField === 'contractFiledAt', JSON.stringify(events));
      ok('attest: lead stamped Contract Filed', db._get('leads/L1').contractFiledAt === 'ISO');
      const r2 = await L.attestWetSigned(db, REP, { leadId: 'L1', docId: 'PAPER' }, deps);
      ok('attest twice: idempotent, no second filing', r2 && r2.ok === true && r2.already === true && events.length === 1, JSON.stringify(r2)); }
    { const { db, deps, events } = mk();
      await L.attestWetSigned(db, REP, { leadId: 'L1', docId: 'COC' }, deps);
      ok('a completion certificate files cocFiledAt', events.length === 1 && events[0].filedField === 'cocFiledAt', JSON.stringify(events));
      await L.attestWetSigned(db, REP, { leadId: 'L1', docId: 'OTHERDOC' }, deps);
      ok('type "other" is certified but files nothing', db._get('leads/L1/documents/OTHERDOC').status === 'signed' && events.length === 1); }
    { const { db, deps } = mk();
      const f = await rejects(() => L.attestWetSigned(db, REP, { leadId: 'L1', docId: 'FUTURE' }, deps));
      ok('a signing date in the future is refused', !!f && f.code === 'failed-precondition', f && f.code);
      const b = await rejects(() => L.attestWetSigned(db, REP, { leadId: 'L1', docId: 'BADTYPE' }, deps));
      ok('an unknown document type is refused', !!b && b.code === 'failed-precondition', b && b.code);
      const g = await rejects(() => L.attestWetSigned(db, REP, { leadId: 'L1', docId: 'GEN' }, deps));
      ok('a generated document is not an uploaded paper copy', !!g && g.code === 'failed-precondition', g && g.code);
      const lg = await rejects(() => L.attestWetSigned(db, REP, { leadId: 'L1', docId: 'LEGACY' }, deps));
      ok('a legacy "signed" upload is not re-attested', !!lg && lg.code === 'failed-precondition', lg && lg.code);
      const bad = await rejects(() => L.attestWetSigned(db, REP, { leadId: '../x', docId: 'PAPER' }, deps));
      ok('bad ids are invalid-argument', !!bad && bad.code === 'invalid-argument', bad && bad.code); }
    { const { db, deps } = mk({ readBytes: async () => { throw new Error('gone'); } });
      const r = await L.attestWetSigned(db, REP, { leadId: 'L1', docId: 'PAPER' }, deps);
      const ev = db._get('leads/L1/documents/PAPER').wetSignedEvidence;
      ok('unreadable original: still certified, digest null with a reason', r.ok === true && ev.originalSha256 === null && ev.originalDigestStatus === 'unreadable', JSON.stringify(ev)); }
    { const s = seed(); s['leads/L1/documents/ORIG'].type = 'work_authorization';
      const db = kit.makeDb(s); const { deps } = mk();
      const e = await rejects(() => L.attestWetSigned(db, REP, { leadId: 'L1', docId: 'PAPER' }, deps));
      ok('original of a different type is refused', !!e && e.code === 'failed-precondition', e && e.code); }
  }

  // ───────────────────────── 1b. paper certification: the browser side ─────────────────────────
  section('1b. upload writer (flag off = today\'s record, flag on = waits for certification)');
  const vm = require('vm');
  const H = require('./helpers/clause-v1-harness');
  const runUpload = async (flagOn, paperCert, loadBundle) => {
    const added = []; const toasts = [];
    const sb = { console: { log() {}, warn() {}, error() {} }, setTimeout, Date, Promise };
    sb.window = sb;
    Object.assign(sb, {
      auth: { currentUser: { uid: 'REP' } }, _customerId: 'L1', db: {}, storage: {},
      ref: (_s, p) => ({ p }), uploadBytes: async () => {}, getDownloadURL: async () => 'https://x.test/scan.jpg',
      collection: (_d, ...parts) => ({ path: parts.join('/') }), serverTimestamp: () => 'TS',
      addDoc: async (c, payload) => { added.push({ c: c.path, payload }); return { id: 'NEW' }; },
      showToast: (m) => toasts.push(String(m)),
      NBDFlags: { enabled: (n) => flagOn && n === 'docClauseSetV1' },
      NBDCustomerDocs: { refresh: async () => {} },
    });
    if (paperCert) sb.NBDPaperCert = paperCert;
    if (loadBundle) sb.ScriptLoader = { loadBundle: async (n) => { loadBundle(sb, n); } };
    vm.createContext(sb);
    vm.runInContext(src('docs/pro/js/customer-signed-doc-upload.js'), sb, { filename: 'customer-signed-doc-upload.js' });
    const input = { files: [{ name: 'scan 1.jpg', size: 1000, type: 'image/jpeg' }], value: 'x' };
    await sb.handleSignedDocUpload(input);
    return { added, toasts };
  };
  { const r = await runUpload(false, null);
    ok('flag off: one row, the exact record shape main writes',
      r.added.length === 1 && Object.keys(r.added[0].payload).sort().join(',') === 'name,size,source,status,type,uploadedAt,uploadedBy,url'
      && r.added[0].payload.status === 'signed' && r.added[0].payload.source === 'signed_upload', JSON.stringify(r.added[0] && Object.keys(r.added[0].payload))); }
  { const form = { docType: 'contract', originalDocId: 'ORIG', signedOn: '2026-11-17', witnessName: 'Pat' };
    const r = await runUpload(true, { collect: async () => form });
    const p = r.added[0] && r.added[0].payload;
    ok('flag on: the row waits (status wet_signed_uploaded), never signed', !!p && p.status === 'wet_signed_uploaded' && p.source === 'signed_upload', JSON.stringify(p));
    ok('flag on: type, link to the original, signing date and witness are recorded',
      p.wetSignedDocType === 'contract' && p.originalDocId === 'ORIG' && p.wetSignedOn === '2026-11-17' && p.witnessName === 'Pat');
    ok('flag on: the upload writes no attestation field (server-owned)', !('wetSignedAttestation' in p) && !('wetSignedEvidence' in p) && !('signedAt' in p)); }
  { const r = await runUpload(true, { collect: async () => ({ docType: 'other', originalDocId: '', signedOn: '2026-11-17', witnessName: '' }) });
    const p = r.added[0].payload;
    ok('flag on: no original and no witness leaves those keys out', !('originalDocId' in p) && !('witnessName' in p) && p.wetSignedDocType === 'other'); }
  { const r = await runUpload(true, { collect: async () => null });
    ok('flag on: cancelling the form uploads nothing', r.added.length === 0); }
  { const r = await runUpload(true, null, null);
    ok('flag on but the certification form did not load: nothing is written (never falls back to "signed")', r.added.length === 0 && r.toasts.some((t) => /could not|did not load|try again/i.test(t)), JSON.stringify(r.toasts)); }
  { const r = await runUpload(true, null, (sb, n) => { if (n === 'docgen') sb.NBDPaperCert = { collect: async () => ({ docType: 'contract', originalDocId: '', signedOn: '2026-11-17', witnessName: '' }) }; });
    ok('flag on: the form is loaded on demand from the docgen bundle', r.added.length === 1 && r.added[0].payload.status === 'wet_signed_uploaded'); }

  section('1b. documents list: "Uploaded, not certified"');
  const loadDocs = async (rows) => {
    const els = {};
    const sb = { console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, document: { addEventListener() {}, getElementById(id) { return (els[id] = els[id] || { id, innerHTML: '' }); } } };
    sb.window = sb; sb._customerId = 'L1'; sb.db = {}; sb.auth = { currentUser: { uid: 'REP' } };
    sb.collection = (_d, ...p) => ({ path: p.join('/') }); sb.query = (c) => ({ legacy: true, ref: c }); sb.where = () => ({}); sb.doc = (_d, ...p) => ({ path: p.join('/') });
    sb.getDocs = async (ref) => (ref && ref.legacy ? { docs: [] } : { docs: rows.map((d) => ({ id: d.id, data: () => d })) });
    vm.runInNewContext(src('docs/pro/js/customer-documents.js'), sb, { filename: 'customer-documents.js' });
    await sb.NBDCustomerDocs.load('L1');
    return { sb, html: els.signedDocsList.innerHTML };
  };
  const day = (iso) => ({ toDate: () => new Date(iso) });
  { const r = await loadDocs([{ id: 'W1', name: 'scan.jpg', url: 'https://x.test/s.jpg', source: 'signed_upload', status: 'wet_signed_uploaded', type: 'image/jpeg', wetSignedDocType: 'contract', uploadedAt: day('2026-11-17T10:00:00Z') }]);
    ok('a waiting upload says "Uploaded, not certified"', /Uploaded, not certified/.test(r.html), r.html.slice(0, 300));
    ok('a waiting upload is NOT marked signed (the old inference read "signed_upload" as signed)', !/✓ Signed/.test(r.html));
    ok('a waiting upload offers the certify button', /data-action="certifyPaperDoc"[^>]*data-arg="W1"/.test(r.html));
    ok('the document-type chip does not read the MIME type', r.sb._customerDocs[0].signed === false); }
  { const r = await loadDocs([{ id: 'W2', name: 'scan.jpg', url: 'https://x.test/s.jpg', source: 'signed_upload', status: 'signed', signedAt: day('2026-11-17T12:00:00Z'), wetSignedAttestation: { byUid: 'REP' }, uploadedAt: day('2026-11-17T10:00:00Z') }]);
    ok('a certified upload reads Signed and offers no certify button', /✓ Signed/.test(r.html) && !/certifyPaperDoc/.test(r.html) && !/not certified/.test(r.html)); }
  { const r = await loadDocs([{ id: 'U9', name: 'old.jpg', url: 'https://x.test/o.jpg', source: 'signed_upload', status: 'signed', uploadedAt: day('2026-11-01T10:00:00Z') }]);
    ok('a pre-existing signed upload is unchanged (no certify button, still Signed)', /✓ Signed/.test(r.html) && !/certifyPaperDoc|not certified/.test(r.html)); }

  section('1b. paper-cert.js (the on-demand form and the certify call)');
  { const pcSrc = (() => { try { return src('docs/pro/js/paper-cert.js'); } catch (e) { return null; } })();
    ok('docs/pro/js/paper-cert.js exists', !!pcSrc);
    if (pcSrc) {
      const calls = []; const toasts = [];
      const sb = { console: { log() {}, warn() {}, error() {} }, setTimeout, Date, Promise };
      sb.window = sb; sb._customerId = 'L1';
      sb._customerDocs = [
        { id: 'C1', generated: true, docType: 'contract', htmlPath: 'documents/REP/L1/a.html', name: 'c1' },
        { id: 'C2', generated: true, docType: 'work_authorization', htmlPath: 'documents/REP/L1/b.html', name: 'wa' },
        { id: 'U1', generated: false, docType: null, name: 'scan' },
      ];
      sb._functions = {}; sb._httpsCallable = (_f, name) => async (payload) => { calls.push({ name, payload }); return { data: { ok: true } }; };
      sb.showToast = (m) => toasts.push(String(m));
      sb.NBDCustomerDocs = { refresh: async () => { calls.push({ name: 'refresh' }); } };
      vm.createContext(sb);
      vm.runInContext(pcSrc, sb, { filename: 'paper-cert.js' });
      const PC = sb.NBDPaperCert;
      ok('exports collect, certify and the attestation sentence', !!PC && typeof PC.collect === 'function' && typeof PC.certify === 'function');
      ok('the sentence shown is the one the server writes', !!PC && PC.ATTEST_TEXT === L.ATTEST_TEXT);
      ok('the originals offered are this customer\'s generated documents of that type',
        JSON.stringify(PC.originalsFor('contract').map((d) => d.id)) === '["C1"]' && PC.originalsFor('other').length === 0);
      ok('the form check: a date is required and cannot be in the future',
        PC.checkForm({ docType: 'contract', signedOn: '' }) !== '' && PC.checkForm({ docType: 'contract', signedOn: '2099-01-01' }) !== ''
        && PC.checkForm({ docType: 'contract', signedOn: '2026-11-17' }) === '' && PC.checkForm({ docType: 'wire', signedOn: '2026-11-17' }) !== '');
      PC._setPrompt(async () => ({ witnessName: ' Chris ' }));
      await PC.certify('W1');
      const c = calls.find((x) => x.name === 'attestWetSigned');
      ok('certify calls attestWetSigned with the ids and the trimmed witness', !!c && c.payload.leadId === 'L1' && c.payload.docId === 'W1' && c.payload.witnessName === 'Chris', JSON.stringify(c));
      ok('certify refreshes the list afterwards', calls.some((x) => x.name === 'refresh'));
      calls.length = 0;
      PC._setPrompt(async () => null);
      await PC.certify('W1');
      ok('declining the attestation calls nothing', calls.length === 0);
    } }

  section('1b. printed copies carry the document id and a short digest (flag on, contract class)');
  const genWith = async (flagOn, type) => {
    const brand = { legalName: 'No Big Deal Home Solutions', entityName: 'No Big Deal Solutions LLC', dbaName: 'No Big Deal Home Solutions', signerTitle: 'Manager', colors: {},
      contact: { email: 'info@nobigdealwithjoedeal.com', phone: '(859) 420-7382', mailingAddress: H.BIZ_ADDR } };
    const env = H.docs({ flags: flagOn ? { docClauseSetV1: true } : {}, brand });
    const W = env.win;
    env.sandbox.Blob = Blob; env.sandbox.TextEncoder = TextEncoder; W.crypto = require('crypto').webcrypto;
    const stored = []; const rows = []; let viewer = null;
    W.db = {}; W.storage = {}; W._user = { uid: 'REP', email: 'rep@x.test' }; W.auth = { currentUser: { uid: 'REP', email: 'rep@x.test' } };
    W.collection = (_d, ...p) => ({ path: p.join('/') });
    W.doc = (c) => ({ id: 'AUTO1234', path: c.path + '/AUTO1234' });
    W.serverTimestamp = () => 'TS';
    W.ref = (_s, p) => ({ p }); W.uploadBytes = async (r, blob) => { stored.push({ p: r.p, text: await blob.text() }); };
    W.addDoc = async (c, row) => { rows.push({ via: 'addDoc', c: c.path, row }); return { id: 'ADDED1' }; };
    W.setDoc = async (r, row) => { rows.push({ via: 'setDoc', path: r.path, row }); };
    W.NBDDocViewer = { open: (o) => { viewer = o; return {}; } };
    const cp = Object.assign({}, H.profileFor(W, H.BIZ_ADDR), { paymentTerms: { deckingPerSheetCents: 10000 } });
    const v = H.VARIANTS.oh_cash;
    W._legal = () => cp;
    W._leadDoc = { id: 'L1', address: v.address, jobType: v.jobType };
    await W.NBDDocGen.generate(type, Object.assign(H.contractData(W, v), { companyProfile: cp }));
    await new Promise((r) => setTimeout(r, 30));
    return { viewer, stored, rows, W };
  };
  { const on = await genWith(true, 'contract');
    const sha12 = kit.sha256(on.stored[0] ? on.stored[0].text : '').slice(0, 12);
    ok('flag on: the viewer copy carries "Document ID" with the id the row is saved under', !!on.viewer && /Document ID[^<]*AUTO1234/.test(on.viewer.html), on.viewer && on.viewer.html.slice(-400));
    ok('flag on: the short digest is the first 12 hex of the stored document\'s SHA-256 (the digest the signing paths use)', !!on.stored[0] && on.viewer.html.indexOf('Digest ' + sha12) !== -1, sha12);
    ok('flag on: the stored original has no footer (so its digest is the same one)', !!on.stored[0] && !/Document ID/.test(on.stored[0].text));
    ok('flag on: the row is created under the id the footer printed', on.rows.length === 1 && on.rows[0].via === 'setDoc' && on.rows[0].path.endsWith('/AUTO1234') && on.rows[0].row.type === 'contract'); }
  { const off = await genWith(false, 'contract');
    ok('flag off: no footer in the viewer copy', !!off.viewer && !/Document ID/.test(off.viewer.html));
    ok('flag off: the viewer copy is byte-identical to the stored original', !!off.stored[0] && off.viewer.html === off.stored[0].text);
    ok('flag off: the row is still created with addDoc', off.rows.length === 1 && off.rows[0].via === 'addDoc'); }
  { const wa = await genWith(true, 'testimonial_sheet').catch((e) => ({ err: e }));
    ok('flag on: a document that is not contract class gets no footer', !wa.err && !!wa.viewer && !/Document ID/.test(wa.viewer.html), wa.err && wa.err.message); }

  console.log('\npaper-cert-signers: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log(fails.join('\n')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
