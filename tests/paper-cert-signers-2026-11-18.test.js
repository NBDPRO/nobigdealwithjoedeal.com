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
    if (loadBundle) sb.ScriptLoader = { load: async (p) => { loadBundle(sb, p); } };
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
  { let asked = '';
    const r = await runUpload(true, null, (sb, p) => { asked = p; if (/paper-cert\.js/.test(p)) sb.NBDPaperCert = { collect: async () => ({ docType: 'contract', originalDocId: '', signedOn: '2026-11-17', witnessName: '' }) }; });
    ok('flag on: the form is loaded on demand with ScriptLoader.load (not through the eager loader list)', asked === 'js/paper-cert.js?v=1' && r.added.length === 1 && r.added[0].payload.status === 'wet_signed_uploaded', asked);
    ok('the eager script-loader.js does not list paper-cert.js', !/paper-cert\.js/.test(src('docs/pro/js/script-loader.js'))); }

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

  // ───────────────────────── 2. signable documents (Q51) ─────────────────────────
  section('2. flag OFF: the five documents are byte-identical (goldens recorded from origin/main)');
  const GOLD2 = JSON.parse(src('tests/fixtures/paper-cert-signers-golden.json'));
  const SIGN2 = [{ role: 'homeowner', label: 'Homeowner', required: true }, { role: 'rep', label: 'Authorized NBD Representative', required: true }];
  const Q51 = ['supplement_request', 'inspectionInsurance', 'warranty_certificate', 'before_after_report', 'lien_waiver'];
  const q51Env = (flagOn) => {
    const env = H.docs({ flags: flagOn ? { docClauseSetV1: true } : {} });
    H.load(env, 'docs/pro/js/document-generator-library.js');
    env.win._leadDoc = { id: 'L1', address: H.OH_ADDR, jobType: 'cash' };
    return env;
  };
  const q51Data = (W, extra) => Object.assign({
    homeownerName: 'Jane Smith', address: H.OH_ADDR, phone: '5135550100', email: 'jane@example.test', claimNumber: 'CLM-8', insuranceCompany: 'State Farm',
    companyProfile: H.profileFor(W, H.BIZ_ADDR), leadId: 'L1', issueDate: '2026-11-18', completionDate: '2026-11-10', certificateNumber: 'WC-1',
    originalApproved: '10000', supplementItems: [], workDescription: 'Roof replacement', amount: '1000', amountPaid: '1000',
  }, extra || {});
  const q51Html = (env, t, signers, extra) => String(env.win.NBDDocGen.getHTML(t, q51Data(env.win, Object.assign(signers ? { signers } : {}, extra || {}))));
  { const off = q51Env(false);
    Q51.forEach((t) => {
      ok(t + ': flag off, no signers = golden', H.sha(q51Html(off, t, null)) === GOLD2[t + '.plain']);
      ok(t + ': flag off, with seeded signers = golden', H.sha(q51Html(off, t, SIGN2)) === GOLD2[t + '.signers']);
    });
    ok('flag off: defaultSignersFor is the registry\'s own defaultSigners, unchanged',
      ['supplement_request', 'inspectionInsurance', 'warranty_certificate', 'before_after_report'].every((t) => off.win.NBDDocGen.defaultSignersFor(t).length === 0)
      && JSON.stringify(off.win.NBDDocGen.defaultSignersFor('lien_waiver')) === JSON.stringify(off.win.NBDDocGen.DOCUMENT_TYPES.lien_waiver.defaultSigners)
      && off.win.NBDDocGen.defaultSignersFor('contract') === off.win.NBDDocGen.DOCUMENT_TYPES.contract.defaultSigners); }

  section('2. flag ON: signers, labels and wording');
  { const on = q51Env(true);
    const D = on.win.NBDDocGen;
    const roles = (t) => D.defaultSignersFor(t).map((s) => s.role).join(',');
    ok('supplement_request signs homeowner + rep, the homeowner line labelled "Homeowner authorization"',
      roles('supplement_request') === 'homeowner,rep' && D.defaultSignersFor('supplement_request')[0].label === 'Homeowner authorization' && D.defaultSignersFor('supplement_request').every((s) => s.required));
    ok('inspectionInsurance gets a homeowner release signer', roles('inspectionInsurance') === 'homeowner' && D.defaultSignersFor('inspectionInsurance')[0].label === 'Homeowner release');
    ok('warranty_certificate gets defaultSigners homeowner + rep', roles('warranty_certificate') === 'homeowner,rep');
    ok('before_after_report gets the homeowner as its one signer', roles('before_after_report') === 'homeowner');
    ok('lien_waiver stays rep-signed', roles('lien_waiver') === 'rep');
    ok('a contract keeps its own signers', roles('contract') === 'homeowner,rep');
    const auth = (html, key) => { const m = new RegExp('<div[^>]*data-nbd-auth="' + key + '"[^>]*>([\\s\\S]*?)<!--end-auth-->').exec(html); return m ? m[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : null; };
    // supplement
    { const h = q51Html(on, 'supplement_request', D.defaultSignersFor('supplement_request'));
      ok('supplement: homeowner block is interactive and labelled', /data-nbd-sig="homeowner"[^>]*data-label="Homeowner authorization"/.test(h));
      ok('supplement: rep block is interactive', /data-nbd-sig="rep"/.test(h));
      const t = auth(h, 'supplement');
      ok('supplement: the authorization paragraph prints', !!t && t.length > 30, String(t));
      ok('supplement: neutral wording (no claim-handling, coverage or payment language)', !!t && !/handle|manage|claim|coverage|covered|approv|guarantee|payment|settle|negotiat/i.test(t), t);
      ok('supplement: the wording is marked for the attorney in the source', /DRAFTER WORDING: attorney to confirm/.test(src('docs/pro/js/document-generator-templates.js')));
      ok('supplement: the old lone "Contractor" static line is gone when signers are seeded', !/Contractor — /.test(h.replace(/<[^>]*>/g, ' ')) || /data-nbd-sig="rep"/.test(h)); }
    { const h = q51Html(on, 'supplement_request', null);
      ok('supplement with no seeded signers still prints the authorization paragraph and a static homeowner line', !!auth(h, 'supplement') && /Homeowner authorization/.test(h)); }
    // inspection report (insurance)
    { const h = q51Html(on, 'inspectionInsurance', D.defaultSignersFor('inspectionInsurance'));
      ok('inspectionInsurance: homeowner release block is interactive and labelled', /data-nbd-sig="homeowner"[^>]*data-label="Homeowner release"/.test(h));
      const t = auth(h, 'release');
      ok('inspectionInsurance: the release paragraph prints', !!t && t.length > 30, String(t));
      ok('inspectionInsurance: no coverage, claim-outcome or payment language', !!t && !/coverage|covered|approv|guarantee|payment|settle|owed|entitled|claim/i.test(t), t);
      ok('inspectionInsurance: the assessor certification line is kept', /Damage Assessor/.test(h)); }
    { const h = q51Html(on, 'inspectionInsurance', null);
      ok('inspectionInsurance with no seeded signers prints the release and a static line', !!auth(h, 'release') && /Homeowner release/.test(h)); }
    // warranty certificate
    { const h = q51Html(on, 'warranty_certificate', D.defaultSignersFor('warranty_certificate'));
      ok('warranty: homeowner and rep are real signature blocks', /data-nbd-sig="homeowner"/.test(h) && /data-nbd-sig="rep"/.test(h)); }
    // before / after
    { const h = q51Html(on, 'before_after_report', D.defaultSignersFor('before_after_report'), { receivedDate: '2026-11-18' });
      const text = h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
      ok('before/after: "Homeowner Acknowledgment" is gone', !/Homeowner Acknowledgment/.test(h));
      ok('before/after: reads "Received on <date>"', /Received on November 18, 2026/.test(text), text.slice(-300));
      ok('before/after: the homeowner signature is a real block', /data-nbd-sig="homeowner"/.test(h)); }
    { const h = q51Html(on, 'before_after_report', null, { receivedDate: '2026-11-18' });
      ok('before/after with no seeded signers: "Received on" and a static line, no empty "Acknowledgment"', /Received on November 18, 2026/.test(h.replace(/<[^>]*>/g, ' ')) && !/Homeowner Acknowledgment/.test(h)); }
  }

  section('2. lien waiver: never emailed to the homeowner');
  const viewerFor = async (flagOn, type, signers, extra) => {
    const env = q51Env(flagOn); const W = env.win;
    const brand = null; void brand;
    env.sandbox.Blob = Blob; env.sandbox.TextEncoder = TextEncoder; W.crypto = require('crypto').webcrypto;
    let viewer = null;
    W.db = {}; W.storage = {}; W._user = { uid: 'REP', email: 'rep@x.test' }; W.auth = { currentUser: { uid: 'REP', email: 'rep@x.test' } };
    W.collection = (_d, ...p) => ({ path: p.join('/') }); W.doc = (c) => ({ id: 'AUTO1234', path: c.path + '/AUTO1234' });
    W.ref = (_s, p) => ({ p }); W.uploadBytes = async () => {}; W.addDoc = async () => ({ id: 'ADDED1' }); W.setDoc = async () => {};
    W.serverTimestamp = () => 'TS';
    W.NBDDocViewer = { open: (o) => { viewer = o; return {}; } };
    await W.NBDDocGen.generate(type, q51Data(W, Object.assign({ signers }, extra || {})));
    await new Promise((r) => setTimeout(r, 20));
    return viewer;
  };
  { const REP_ONLY = [{ role: 'rep', label: 'Authorized NBD Representative', required: true }];
    const on = await viewerFor(true, 'lien_waiver', REP_ONLY);
    ok('flag on: a rep-only document offers no "send for signature" (it would email the homeowner)', !!on && on.onSendForSignature === null, on && typeof on.onSendForSignature);
    const off = await viewerFor(false, 'lien_waiver', REP_ONLY);
    ok('flag off: the lien waiver behaves exactly as before (send offered)', !!off && typeof off.onSendForSignature === 'function');
    const two = await viewerFor(true, 'warranty_certificate', SIGN2);
    ok('flag on: a document with a homeowner signer still offers send for signature', !!two && typeof two.onSendForSignature === 'function'); }
  { // the server refuses too: a rep-only row is never given a homeowner sign link.
    const P = 'documents/U1/L1/d-1.html';
    const html = '<!DOCTYPE html><html><body><h1>Lien Waiver</h1><div data-nbd-sig="rep" data-nbd-sig-required="1"><canvas width="300" height="100"></canvas></div></body></html>';
    const K = require(path.join(FN, 'ky-insurance-law.js'));
    const ESL = require(path.join(FN, 'esign-logic.js'));
    const DE = require(path.join(FN, 'doc-evidence.js'));
    const REAL = ['./ky-insurance-law', './cancel-window', './lead-artifact-paths', './esign-logic', './doc-evidence', './await-briefly', './signed-price', 'crypto'];
    const stubs = { './cancel-window': require(path.join(FN, 'cancel-window.js')), './ky-insurance-law': K, './lead-artifact-paths': require(path.join(FN, 'lead-artifact-paths.js')),
      './esign-logic': ESL, './doc-evidence': DE, './await-briefly': require(path.join(FN, 'await-briefly.js')), './signed-price': require(path.join(FN, 'signed-price.js')) };
    const mint = async (flagOn, signers) => {
      const db = kit.makeDb({
        'leads/L1': { userId: 'U1', companyId: 'U1', firstName: 'Dana', lastName: 'Whitfield', email: 'dana@example.test', address: '12 Oak St, Cincinnati, OH 45202' },
        'leads/L1/documents/d1': { type: 'lien_waiver', typeName: 'Lien Waiver', htmlPath: P, userId: 'U1', signers },
        'companyProfile/U1': { brand: { legalName: 'Acme Roofing LLC', entityName: 'Acme Roofing LLC', contact: { mailingAddress: '1 Main St, Cincinnati, OH 45202' } } },
        'feature_flags/_default': flagOn ? { docClauseSetV1: true } : {},
      });
      const Lh = kit.loadHandler('remote-signing.js', db, kit.makeStorage({ [P]: html }), stubs, REAL);
      try { return { v: await Lh.fns.createSignRequest({ auth: { uid: 'U1', token: {} }, data: { leadId: 'L1', docId: 'd1', signerEmail: 'dana@example.test', signerName: 'Dana' } }), db }; }
      catch (e) { return { e, db }; }
    };
    const repOnly = [{ role: 'rep', label: 'Rep', required: true }];
    let r = await mint(true, repOnly);
    ok('server, flag on: a rep-only document is refused (failed-precondition) and no token is minted', !!r.e && r.e.code === 'failed-precondition' && r.db._all('doc_sign_tokens').length === 0, r.e && r.e.code + ' ' + r.e.message);
    r = await mint(true, [{ role: 'homeowner', required: true }, { role: 'rep', required: true }]);
    ok('server, flag on: a document with a homeowner signer is still sent', !!r.v && r.db._all('doc_sign_tokens').length === 1, r.e && r.e.message);
    r = await mint(false, repOnly);
    ok('server, flag off: unchanged (a rep-only document still sends)', !!r.v && r.db._all('doc_sign_tokens').length === 1, r.e && r.e.message); }

  // ───────────────────────── 3. co-owners (Q52) ─────────────────────────
  section('3. co-owner: pre-flight (role, field, add-signer)');
  { const mkPf = (flagOn) => { const env = H.docs({ flags: flagOn ? { docClauseSetV1: true } : {} }); return env.win.DocPreflight; };
    const off = mkPf(false); const on = mkPf(true);
    ok('DocPreflight exposes schemaFor, signerToAdd and ensureCoOwner', ['schemaFor', 'signerToAdd', 'ensureCoOwner'].every((k) => typeof on['_' + k] === 'function' || typeof on[k] === 'function'));
    const sf = (P, t) => (P.schemaFor || P._schemaFor)(t);
    ok('flag off: the contract schema is the registry\'s own object (no second-owner field)', sf(off, 'contract') === off.DOC_SCHEMAS.contract
      && !JSON.stringify(off.DOC_SCHEMAS.contract).includes('secondOwnerName'));
    { const s = sf(on, 'contract'); const all = [].concat.apply([], s.sections.map((x) => x.fields));
      const f = all.find((x) => x.key === 'secondOwnerName');
      ok('flag on: the contract pre-flight has an optional "Second owner" name that persists to the lead', !!f && f.persist === 'lead' && !f.required && /second owner/i.test(f.label), JSON.stringify(f)); }
    ok('flag on: other document types keep their own schema', sf(on, 'proposal') === on.DOC_SCHEMAS.proposal && sf(on, 'change_order') === on.DOC_SCHEMAS.change_order);
    const sa = (P) => P.signerToAdd || P._signerToAdd;
    const existing = [{ role: 'homeowner', label: 'Homeowner', required: true, enabled: true }, { role: 'rep', label: 'Rep', required: true, enabled: true }];
    { const r = sa(on)(existing, 'homeowner');
      ok('flag on: adding a second "Homeowner" creates the distinct role homeowner2, labelled co-owner, required', r.role === 'homeowner2' && r.label === 'Homeowner (co-owner)' && r.required === true, JSON.stringify(r)); }
    { const r = sa(on)([], 'homeowner'); ok('flag on: the first homeowner is still "homeowner"', r.role === 'homeowner' && r.label === 'Homeowner'); }
    { const r = sa(on)(existing, 'homeowner2'); ok('flag on: the picker can add the co-owner directly', r.role === 'homeowner2' && r.label === 'Homeowner (co-owner)'); }
    { const r = sa(off)(existing, 'homeowner');
      ok('flag off: a second "Homeowner" is the same role as before', r.role === 'homeowner' && r.label === 'Homeowner' && r.required === false, JSON.stringify(r)); }
    { const r = sa(on)(existing, 'witness'); ok('flag on: other roles are unchanged', r.role === 'witness' && r.label === 'Witness'); }
    const ens = (P) => P.ensureCoOwner || P._ensureCoOwner;
    { const r = ens(on)(existing.map((s) => Object.assign({}, s)), 'Pat Smith', 'contract');
      ok('a second owner name adds the co-owner signer (required, enabled)', !r.error && r.signers.some((s) => s.role === 'homeowner2' && s.required === true && s.enabled !== false), JSON.stringify(r)); }
    { const withCo = existing.concat([{ role: 'homeowner2', label: 'Homeowner (co-owner)', required: true, enabled: false }]);
      const r = ens(on)(withCo, 'Pat Smith', 'contract');
      ok('a second owner listed but the co-owner signer switched off is refused', !!r.error && /every owner|second owner|co-owner/i.test(r.error), JSON.stringify(r)); }
    { const r = ens(on)(existing.map((s) => Object.assign({}, s)), '   ', 'contract'); ok('no second owner: signers unchanged', !r.error && r.signers.length === 2); }
    { const r = ens(off)(existing.map((s) => Object.assign({}, s)), 'Pat Smith', 'contract'); ok('flag off: nothing is added or refused', !r.error && r.signers.length === 2); }
    { const r = ens(on)(existing.map((s) => Object.assign({}, s)), 'Pat Smith', 'change_order'); ok('only contract-class documents require the co-owner', !r.error && r.signers.length === 2); }
  }

  section('3. co-owner: the send gate (shared module, client and server)');
  { const C = require(path.join(FN, 'doc-send-checks.js'));
    const base = { type: 'contract', priceCents: 1450000, address: '1 A St', homeownerName: 'Dana', mailingAddress: '1 Main', needsMailingAddress: true, entityName: 'X LLC', startDate: 'Dec 1', estimatedCompletion: '5 days', text: '<p>ok</p>' };
    const codes = (o) => C.contractGaps(Object.assign({}, base, o)).map((g) => g.code);
    ok('two owners, one homeowner signer: refused (coOwner)', codes({ secondOwnerName: 'Pat Smith', signerRoles: ['homeowner', 'rep'] }).includes('coOwner'));
    ok('the refusal names the second owner', C.contractGaps(Object.assign({}, base, { secondOwnerName: 'Pat Smith', signerRoles: ['homeowner', 'rep'] })).some((g) => /Pat Smith/.test(g.message)));
    ok('two owners, both signers: clear', !codes({ secondOwnerName: 'Pat Smith', signerRoles: ['homeowner', 'homeowner2', 'rep'] }).includes('coOwner'));
    ok('no second owner: unchanged', !codes({ signerRoles: ['homeowner', 'rep'] }).includes('coOwner') && codes({}).length === 0);
    ok('a second owner with the signer list unknown is not guessed at', !codes({ secondOwnerName: 'Pat Smith' }).includes('coOwner'));
    const twinOk = src('docs/pro/js/doc-send-checks.js') === src('functions/doc-send-checks.js');
    ok('the browser and functions copies of doc-send-checks.js are byte-identical', twinOk); }

  section('3. co-owner: the server refuses a contract that lists two owners with one signer');
  { const P = 'documents/U1/L1/d-1.html';
    const K = require(path.join(FN, 'ky-insurance-law.js')); const ESL = require(path.join(FN, 'esign-logic.js')); const DE = require(path.join(FN, 'doc-evidence.js'));
    const CONTRACT = '<!DOCTYPE html><html><head><title>Roofing Contract</title></head><body><h1>Roofing Contract</h1><p>Contract price: $14,500.00</p>'
      + '<!--nbd-cancel-packet:start--><section data-nbd-cancel-by="2026-11-17"><h2>Notice of Right to Cancel</h2>'
      + '<div data-nbd-noc="ftc"><p>NOTICE OF CANCELLATION. NOT LATER THAN MIDNIGHT OF November 17, 2026</p></div>'
      + '<div data-nbd-noc="ftc"><p>NOTICE OF CANCELLATION. NOT LATER THAN MIDNIGHT OF November 17, 2026</p></div>'
      + '</section><!--nbd-cancel-packet:end-->'
      + '<div data-nbd-sig="homeowner" data-nbd-sig-required="1"><canvas width="300" height="100"></canvas></div></body></html>';
    const PROFILE = { brand: { legalName: 'Acme Roofing LLC', entityName: 'Acme Roofing LLC', contact: { mailingAddress: '1 Main St, Cincinnati, OH 45202' } } };
    const leadX = (extra) => Object.assign({ userId: 'U1', companyId: 'U1', firstName: 'Dana', lastName: 'Whitfield', email: 'dana@example.test', address: '12 Oak St, Cincinnati, OH 45202', jobType: 'cash', primaryEstimateId: 'E1' }, extra || {});
    const REAL = ['./ky-insurance-law', './cancel-window', './lead-artifact-paths', './esign-logic', './doc-evidence', './await-briefly', './signed-price', 'crypto'];
    const stubs = () => ({ './cancel-window': require(path.join(FN, 'cancel-window.js')), './ky-insurance-law': K, './lead-artifact-paths': require(path.join(FN, 'lead-artifact-paths.js')),
      './esign-logic': ESL, './doc-evidence': DE, './await-briefly': require(path.join(FN, 'await-briefly.js')), './signed-price': require(path.join(FN, 'signed-price.js')) });
    const ROLE = (r) => ({ role: r, required: true });
    const seedRS = (flags, lead, signers) => {
      const s = { 'leads/L1': lead, 'leads/L1/documents/d1': { type: 'contract', typeName: 'Roofing Contract', htmlPath: P, userId: 'U1', signers }, 'companyProfile/U1': PROFILE, 'estimates/E1': { grandTotal: 14500 } };
      if (flags) s['feature_flags/_default'] = flags;
      return s;
    };
    const mint = async (flags, lead, signers) => {
      const db = kit.makeDb(seedRS(flags, lead, signers));
      const Lh = kit.loadHandler('remote-signing.js', db, kit.makeStorage({ [P]: CONTRACT }), stubs(), REAL);
      try { return { v: await Lh.fns.createSignRequest({ auth: { uid: 'U1', token: {} }, data: { leadId: 'L1', docId: 'd1', signerEmail: 'dana@example.test', signerName: 'Dana Whitfield' } }), db }; }
      catch (e) { return { e, db }; }
    };
    const FLAG = { docClauseSetV1: true };
    let r = await mint(FLAG, leadX({ secondOwnerName: 'Pat Whitfield' }), [ROLE('homeowner'), ROLE('rep')]);
    ok('remote: flag on, two owners listed, one homeowner signer: refused, no link', !!r.e && r.e.code === 'failed-precondition' && /Pat Whitfield/.test(r.e.message) && r.db._all('doc_sign_tokens').length === 0, r.e && r.e.message);
    r = await mint(FLAG, leadX({ secondOwnerName: 'Pat Whitfield' }), [ROLE('homeowner'), ROLE('homeowner2'), ROLE('rep')]);
    ok('remote: flag on, both owners are signers: sent', !!r.v && r.db._all('doc_sign_tokens').length === 1, r.e && r.e.message);
    r = await mint(FLAG, leadX(), [ROLE('homeowner'), ROLE('rep')]);
    ok('remote: flag on, one owner: sent', !!r.v && r.db._all('doc_sign_tokens').length === 1, r.e && r.e.message);
    r = await mint(null, leadX({ secondOwnerName: 'Pat Whitfield' }), [ROLE('homeowner'), ROLE('rep')]);
    ok('remote: flag off: unchanged (sent)', !!r.v && r.db._all('doc_sign_tokens').length === 1, r.e && r.e.message);
    // in person
    const Lg = require(path.join(FN, 'in-person-signing-logic.js'));
    const callIP = async (flags, lead, signers, signedSigners) => {
      const s = { 'leads/L1': lead, 'leads/L1/documents/d1': { type: 'contract', status: 'signed', signedAt: { toMillis: () => 1766000000000 }, signers, signedSigners, htmlPath: P }, 'estimates/E1': { grandTotal: 14500 }, 'companyProfile/U1': PROFILE };
      if (flags) s['feature_flags/_default'] = flags;
      const db = kit.makeDb(s);
      const W = kit.loadHandler('in-person-signing.js', db, kit.makeStorage({ [P]: CONTRACT }), { './in-person-signing-logic': Lg, './doc-evidence': DE }, []);
      try { return { v: await W.fns.recordInPersonSignature({ auth: { uid: 'U1', token: {} }, data: { leadId: 'L1', docId: 'd1' }, rawRequest: { headers: { 'x-forwarded-for': '203.0.113.5' }, get: () => 'RepPhone/1' } }), db }; }
      catch (e) { return { e, db }; }
    };
    const signedBoth = [{ role: 'homeowner', signedAt: 1 }, { role: 'homeowner2', signedAt: 2 }, { role: 'rep', signedAt: 3 }];
    let c = await callIP(FLAG, leadX({ secondOwnerName: 'Pat Whitfield' }), [ROLE('homeowner'), ROLE('rep')], [{ role: 'homeowner', signedAt: 1 }, { role: 'rep', signedAt: 3 }]);
    ok('in person: flag on, two owners listed, the co-owner never a signer: refused', !!c.e && /Pat Whitfield/.test(String(c.e.message)), c.e && c.e.message);
    c = await callIP(FLAG, leadX({ secondOwnerName: 'Pat Whitfield' }), [ROLE('homeowner'), ROLE('homeowner2'), ROLE('rep')], [{ role: 'homeowner', signedAt: 1 }, { role: 'rep', signedAt: 3 }]);
    ok('in person: the co-owner is a required signer who did not sign: not recorded as signed', !!c.e && /not signed|missing_required_signer/.test(String(c.e.message)), c.e && c.e.message);
    c = await callIP(FLAG, leadX({ secondOwnerName: 'Pat Whitfield' }), [ROLE('homeowner'), ROLE('homeowner2'), ROLE('rep')], signedBoth);
    ok('in person: both owners signed: recorded', !!c.v && c.v.ok === true, c.e && c.e.message);
    c = await callIP(null, leadX({ secondOwnerName: 'Pat Whitfield' }), [ROLE('homeowner'), ROLE('rep')], [{ role: 'homeowner', signedAt: 1 }, { role: 'rep', signedAt: 3 }]);
    ok('in person: flag off: unchanged', !!c.v && c.v.ok === true, c.e && c.e.message); }

  section('3. co-owner: evidence records both signers; saved signatures are looked up per role');
  { const DE = require(path.join(FN, 'doc-evidence.js'));
    ok('DE.signedRoles exists', typeof DE.signedRoles === 'function');
    if (typeof DE.signedRoles === 'function') {
      const blk = (role, label, at) => '<div class="nbd-sig-block" data-nbd-sig="' + role + '" data-label="' + label + '" data-required="true" data-nbd-sig-finalized="1" data-nbd-sig-signed-at="' + at + '"><img src="data:image/png;base64,AAAA"></div>';
      const html = '<body>' + blk('homeowner', 'Homeowner', '2026-11-18T15:00:00.000Z') + blk('homeowner2', 'Homeowner (co-owner)', '2026-11-18T15:01:00.000Z')
        + '<div class="nbd-sig-block" data-nbd-sig="rep" data-label="Rep" data-required="true"><canvas></canvas></div></body>';
      const got = DE.signedRoles(html);
      ok('both finalized owners are listed with their time; the unsigned rep block is not', got.length === 2 && got[0].role === 'homeowner' && got[1].role === 'homeowner2' && got[1].label === 'Homeowner (co-owner)' && /2026-11-18T15:01/.test(got[1].signedAt), JSON.stringify(got));
      ok('no signature blocks: an empty list', DE.signedRoles('<p>x</p>').length === 0 && DE.signedRoles(null).length === 0); }
    // in-person: the stored record is read and both signers are written into the evidence
    const Lg = require(path.join(FN, 'in-person-signing-logic.js'));
    const P = 'documents/U1/L1/d-1.html';
    const blk2 = (role, at) => '<div data-nbd-sig="' + role + '" data-label="' + role + '" data-nbd-sig-finalized="1" data-nbd-sig-signed-at="' + at + '"><img src="data:image/png;base64,AAAA"></div>';
    const html = '<html><body><p>Contract price $14,500.00</p>' + blk2('homeowner', '2026-11-18T15:00:00.000Z') + blk2('homeowner2', '2026-11-18T15:01:00.000Z') + '</body></html>';
    const db = kit.makeDb({
      'leads/L1': { userId: 'U1', companyId: 'U1' },
      'leads/L1/documents/d1': { type: 'work_authorization', status: 'signed', signedAt: { toMillis: () => 1 }, signers: [{ role: 'homeowner', required: true }, { role: 'homeowner2', required: true }], signedSigners: [{ role: 'homeowner' }, { role: 'homeowner2' }], htmlPath: P },
    });
    // a non-contract-class type skips the gap check, so the evidence write is what is under test
    const w = await Lg.recordEvidence(db, { leadId: 'L1', docId: 'd1', lead: { userId: 'U1', companyId: 'U1' }, docMeta: db._get('leads/L1/documents/d1'), uid: 'U1', data: {} },
      { enabled: true, clauseFlag: true, ip: '203.0.113.5', ipSource: 'socket', ua: 'UA', readBytes: async () => Buffer.from(html) });
    ok('in-person evidence lists both owners', !!w && Array.isArray(w.signers) && w.signers.map((s) => s.role).join(',') === 'homeowner,homeowner2', JSON.stringify(w && w.signers)); }
  { const stub = (extra) => ({ docs: [{ id: 'homeowner', data: () => ({ png: 'PNG-A' }) }, { id: 'homeowner2', data: () => ({ png: 'PNG-B' }) }], forEach(fn) { this.docs.forEach(fn); } });
    const env = q51Env(true); const W = env.win;
    W.db = {}; W.collection = (_d, ...p) => ({ path: p.join('/') }); W.getDocs = async () => stub();
    const got = await W.NBDDocGen._fetchSavedSignatures('L1');
    ok('saved signatures are keyed by role: the co-owner has their own, not the first owner\'s', got.homeowner === 'PNG-A' && got.homeowner2 === 'PNG-B', JSON.stringify(got)); }
  { const env = q51Env(true);
    const html = env.win.NBDDocGen.renderSignatureBlock([{ role: 'homeowner', label: 'Homeowner', required: true }, { role: 'homeowner2', label: 'Homeowner (co-owner)', required: true }, { role: 'rep', label: 'Rep', required: true }]);
    ok('the co-owner renders as its own signature block with its own role', /data-nbd-sig="homeowner2"[^>]*data-label="Homeowner \(co-owner\)"/.test(html) && (html.match(/data-nbd-sig="homeowner"/g) || []).length === 1); }

  // ───────────────────────── 4. in-person consent tick (Q62) ─────────────────────────
  section('4. the sentence: ESIGN-1 verbatim from the registry');
  const packet = src('tests/fixtures/attorney-packet-2026-11-18.md');
  const esignFromPacket = (() => {
    const i = packet.indexOf('#### ESIGN-1');
    const block = packet.slice(i, packet.indexOf('Today the in-person signing path', i));
    return block.split('\n').filter((l) => l.startsWith('> ')).map((l) => l.slice(2).trim()).join(' ');
  })();
  { const CSbrowser = H.docs({}).win.NBDClauseSet;
    const CSserver = require(path.join(FN, 'clause-set.js'));
    ok('the packet\'s ESIGN-1 text was found', esignFromPacket.length > 100 && /^You agree to sign this contract/.test(esignFromPacket), esignFromPacket.slice(0, 60));
    ok('NBDClauseSet.esignConsentText(true) is the packet sentence verbatim', CSbrowser.esignConsentText(true) === esignFromPacket, CSbrowser.esignConsentText(true));
    ok('the server twin answers the same sentence', CSserver.esignConsentText(true) === esignFromPacket);
    ok('another tenant reads "Contractor" for the defined term NBD', CSbrowser.esignConsentText(false) === esignFromPacket.replace(/\bNBD\b/g, 'Contractor') && !/\bNBD\b/.test(CSbrowser.esignConsentText(false)));
    ok('clause-set.js twins stay byte-identical', src('docs/pro/js/clause-set.js') === src('functions/clause-set.js')); }

  section('4. the viewer: a required tick above the document, passed to the signing widget');
  { const viewerSrc = src('docs/pro/js/nbd-doc-viewer.js');
    // The bar is built by paper-cert.js (lazy), not the eager viewer file (the dashboard's shipped byte ceiling has no headroom).
    const VS = vm.createContext({ window: {}, document: { getElementById() { return null; }, createElement() { return {}; }, addEventListener() {}, body: {} }, console, setTimeout, clearTimeout });
    VS.window = VS; try { vm.runInContext(src('docs/pro/js/paper-cert.js'), VS, { filename: 'paper-cert.js' }); } catch (e) { ok('paper-cert.js loads in a stub page', false, e.message); }
    const V = { _consentBar: VS.NBDPaperCert && VS.NBDPaperCert.consentBar, mount: VS.NBDPaperCert && VS.NBDPaperCert.mountConsent };
    ok('the lazy module exposes the consent bar builder and the mount', typeof V._consentBar === 'function' && typeof V.mount === 'function');
    // The eager viewer and role-gate are untouched on purpose (the dashboard's shipped byte ceiling has no headroom;
    // tests/dashboard-boot-budget guards the bytes). So the viewer's own guard for a read-only role is behaviour here:
    { const guard = { calls: 0 }; const certified = [];
      const sb = { console, window: null, NBDRole: { guard: () => { guard.calls++; return false; } }, NBDPaperCert: { certify: async (id) => certified.push(id) } };
      sb.window = sb; vm.createContext(sb);
      vm.runInContext(src('docs/pro/js/customer-signed-doc-upload.js'), sb, { filename: 'customer-signed-doc-upload.js' });
      await sb.certifyPaperDoc('W1');
      ok('a read-only role cannot open the certify form (certifyPaperDoc guards itself)', guard.calls === 1 && certified.length === 0);
      sb.NBDRole.guard = () => true; await sb.certifyPaperDoc('W1');
      ok('an allowed role reaches certify', certified.join() === 'W1'); }
    { // mountConsent: bar inserted before the viewer body, the lock message sent on load and on every change
      const sent = []; const inserted = []; let loadFn = null;
      const mkEl = (tag) => ({ tag, children: [], attrs: {}, listeners: {}, style: {}, textContent: '', checked: false, appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, fn) { this.listeners[t] = fn; } });
      const docStub = { createElement: mkEl };
      const bodyEl = { parentNode: { insertBefore: (n, ref) => inserted.push({ n, ref }) } };
      const iframe = { parentNode: bodyEl, contentWindow: { postMessage: (m) => sent.push(m) }, addEventListener: (t, fn) => { if (t === 'load') loadFn = fn; } };
      const st = V.mount(docStub, iframe, { label: 'I agree to sign electronically', text: esignFromPacket });
      ok('mountConsent inserts the bar above the viewer body', inserted.length === 1 && inserted[0].ref === bodyEl);
      loadFn(); ok('on load the widget is told consent is required and not agreed', sent.length === 1 && sent[0].__nbd_sig === 'consent' && sent[0].required === true && sent[0].agreed === false);
      const tickEl = inserted[0].n.children[0].children[0]; tickEl.checked = true; tickEl.listeners.change();
      ok('ticking tells the widget agreed:true and the live state follows', sent[sent.length - 1].agreed === true && st.agreed === true); }
    if (V && typeof V._consentBar === 'function') {
      const made = [];
      const fakeDoc = { createElement: (tag) => { const el = { tag, children: [], attrs: {}, listeners: {}, style: {}, textContent: '', checked: false,
        appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, fn) { this.listeners[t] = fn; } }; made.push(el); return el; } };
      const changes = [];
      const bar = V._consentBar(fakeDoc, { label: 'I agree to sign electronically', text: esignFromPacket }, (agreed) => changes.push(agreed));
      const flat = (e) => [e].concat((e.children || []).flatMap(flat));
      const all = flat(bar.el);
      const tick = all.find((e) => e.tag === 'input' && e.attrs.type === 'checkbox');
      ok('a checkbox is the control', !!tick);
      ok('the label reads "I agree to sign electronically"', all.some((e) => e.textContent === 'I agree to sign electronically'));
      ok('the packet sentence is shown on the bar, verbatim', all.some((e) => e.textContent === esignFromPacket));
      ok('the tick starts off (nothing agreed until the homeowner ticks)', bar.state.agreed === false);
      tick.checked = true; tick.listeners.change(); ok('ticking records agreement and tells the widget', bar.state.agreed === true && changes[changes.length - 1] === true);
      tick.checked = false; tick.listeners.change(); ok('unticking withdraws it and tells the widget', bar.state.agreed === false && changes[changes.length - 1] === false);
      ok('the tick is 24px or larger for a finger', /(^|;)\s*width:\s*(2[4-9]|[3-9]\d)px/.test(tick.attrs.style || '') || (tick.style && parseInt(tick.style.width, 10) >= 24)); }
    { // the bar leaves with the viewer: the overlay losing its "open" class removes it, and a later bar replaces a stale one
      let cb = null; const removed = []; const classes = new Set(['open']);
      VS.MutationObserver = function (fn) { cb = fn; this.observe = () => {}; this.disconnect = () => { cb = null; }; };
      const overlay = { classList: { contains: (c) => classes.has(c) } };
      const mk = (tag) => ({ tag, children: [], attrs: {}, listeners: {}, style: {}, textContent: '', appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, fn) { this.listeners[t] = fn; } });
      const stale = { parentNode: { removeChild: (n) => removed.push(n) } };
      const docStub = { createElement: mk, getElementById: (id) => (id === 'nbd-doc-viewer-overlay' ? overlay : (id === 'nbdv-consent' ? stale : null)) };
      let mounted = null;
      const barParent = { insertBefore: (n) => { mounted = n; n.parentNode = { removeChild: (x) => removed.push(x) }; } };
      const iframe = { parentNode: { parentNode: barParent }, contentWindow: { postMessage() {} }, addEventListener() {} };
      V.mount(docStub, iframe, { label: 'x', text: 'y' });
      ok('a stale bar from an earlier open is removed before the new one mounts', removed.length === 1 && removed[0] === stale);
      ok('the bar watches the overlay\'s class', typeof cb === 'function' && !!mounted);
      cb(); ok('while the viewer is open the bar stays', removed.indexOf(mounted) === -1);
      classes.delete('open'); cb();
      ok('closing the viewer (the overlay loses "open") removes the bar', removed.indexOf(mounted) !== -1); } }

  section('4. the signing widget: no drawing, no saved signature and no finalize until the tick');
  { const wsrc = src('docs/pro/js/signature-widget.js');
    const mkWidget = () => {
      const listeners = {}; const msgs = [];
      const ctx = { calls: 0, scale() {}, beginPath() { this.calls++; }, moveTo() {}, lineTo() {}, stroke() {}, clearRect() {}, drawImage() {}, fillRect() {}, fillStyle: '' };
      const handlers = {};
      const canvas = { getContext: () => ctx, getBoundingClientRect: () => ({ width: 300, height: 120, left: 0, top: 0 }), style: {}, width: 0, height: 0,
        addEventListener(t, fn) { handlers[t] = fn; }, dispatchEvent() {}, setPointerCapture() {}, parentNode: null, toDataURL: () => 'data:image/png;base64,AA' };
      const attrs = { 'data-nbd-sig': 'homeowner', 'data-label': 'Homeowner', 'data-required': 'true' };
      const block = { getAttribute: (k) => (k in attrs ? attrs[k] : null), setAttribute(k, v) { attrs[k] = v; }, querySelector: (sel) => (/canvas/.test(sel) ? canvas : null) };
      const heads = [];
      const document = { readyState: 'complete', head: { appendChild(e) { heads.push(e); }, removeChild(e) { const i = heads.indexOf(e); if (i >= 0) heads.splice(i, 1); } },
        body: {}, documentElement: { outerHTML: '<html></html>' }, querySelectorAll: (s) => (/data-nbd-sig\]$/.test(s) ? [block] : []),
        createElement: () => ({ style: {}, setAttribute() {}, getContext: () => ctx, toDataURL: () => 'data:image/png;base64,AA' }), addEventListener() {} };
      const win = { __NBD_LOADED: {}, devicePixelRatio: 1, addEventListener(t, fn) { listeners[t] = fn; }, parent: { postMessage(m) { msgs.push(m); } }, CustomEvent: function () {} };
      const sb = { window: win, document, console, setTimeout, clearTimeout, Image: function () {}, CustomEvent: function () {}, MutationObserver: function () { this.observe = function () {}; } };
      win.window = win; Object.assign(win, sb); vm.createContext(sb);
      vm.runInContext(wsrc, sb, { filename: 'signature-widget.js' });
      const send = (d) => listeners.message({ data: d, source: win.parent });
      const down = () => handlers.pointerdown({ preventDefault() {}, clientX: 5, clientY: 5, pointerId: 1 });
      const move = () => handlers.pointermove({ preventDefault() {}, clientX: 20, clientY: 20 });
      const up = () => handlers.pointerup({});
      const draw = () => { const before = ctx.calls; down(); move(); up(); return ctx.calls > before; };
      return { send, draw, msgs, heads, ctx };
    };
    { const w = mkWidget();
      ok('no consent message: drawing works exactly as before', w.draw() === true);
      w.send({ __nbd_sig: 'finalize' }); const fin = w.msgs[w.msgs.length - 1];
      ok('no consent message: finalize succeeds for a signed pad', fin && fin.ok === true, JSON.stringify(fin && { ok: fin.ok })); }
    { const w = mkWidget();
      w.send({ __nbd_sig: 'consent', required: true, agreed: false });
      ok('consent required, not agreed: a stroke is ignored', w.draw() === false);
      w.send({ __nbd_sig: 'consent', required: true, agreed: true });
      ok('consent agreed: drawing works', w.draw() === true);
      w.send({ __nbd_sig: 'consent', required: true, agreed: false });
      w.send({ __nbd_sig: 'finalize' }); const fin = w.msgs[w.msgs.length - 1];
      ok('consent withdrawn after drawing: finalize refuses with needsConsent', fin && fin.ok === false && fin.needsConsent === true, JSON.stringify(fin && { ok: fin.ok, nc: fin.needsConsent }));
      w.send({ __nbd_sig: 'consent', required: true, agreed: true });
      w.send({ __nbd_sig: 'finalize' }); const fin2 = w.msgs[w.msgs.length - 1];
      ok('consent agreed again: finalize succeeds', fin2 && fin2.ok === true);
      ok('the lock sheet is cut out of the saved record', !/nbd-sig-consent-lock/.test(String(fin2 && fin2.html))); }
    { const w = mkWidget();
      w.send({ __nbd_sig: 'consent', required: true, agreed: false });
      w.send({ __nbd_sig: 'finalize' }); const fin = w.msgs[w.msgs.length - 1];
      ok('locked and nothing signed: the existing "required signature missing" answer, not a consent one', fin && fin.ok === false && !fin.needsConsent && Array.isArray(fin.missing) && fin.missing[0] === 'homeowner', JSON.stringify(fin && { ok: fin.ok, missing: fin.missing })); } }

  section('4. the generator: the tick is asked for on contract-class in-person signing, and recorded');
  // consentMode: 'stub' = a paper-cert.js whose mounted bar state the test controls; 'none' = the module never loads;
  // 'loader' = the module arrives through ScriptLoader.load (the on-demand path).
  const genSigned = async (flagOn, type, signers, consentMode) => {
    const brand = { legalName: 'No Big Deal Home Solutions', entityName: 'No Big Deal Solutions LLC', dbaName: 'No Big Deal Home Solutions', signerTitle: 'Manager', colors: {},
      contact: { email: 'info@nobigdealwithjoedeal.com', phone: '(859) 420-7382', mailingAddress: H.BIZ_ADDR } };
    const env = H.docs({ flags: flagOn ? { docClauseSetV1: true } : {}, brand });
    const W = env.win;
    env.sandbox.Blob = Blob; env.sandbox.TextEncoder = TextEncoder; W.crypto = require('crypto').webcrypto;
    const calls = []; const updates = []; let viewer = null;
    W.db = {}; W.storage = {}; W._user = { uid: 'REP', email: 'rep@x.test' }; W.auth = { currentUser: { uid: 'REP', email: 'rep@x.test' } };
    W.collection = (_d, ...p) => ({ path: p.join('/') }); W.doc = (c, ...p) => ({ id: p.length ? p[p.length - 1] : 'AUTO1234', path: (c && c.path ? c.path : 'x') + '/' + p.join('/') });
    W.serverTimestamp = () => 'TS'; W.ref = (_s, p) => ({ p }); W.uploadBytes = async () => {};
    W.addDoc = async () => ({ id: 'ADDED1' }); W.setDoc = async () => {}; W.updateDoc = async (r, patch) => { updates.push({ path: r.path, patch }); };
    W._functions = {}; W._httpsCallable = (_f, name) => async (payload) => { calls.push({ name, payload }); return { data: { ok: true } }; };
    W.NBDDocViewer = { open: (o) => { viewer = o; return {}; } };
    const consentState = { agreed: false }; const mounts = []; const loads = [];
    const stubModule = { mountConsent: (doc, iframe, consent) => { mounts.push(consent); return consentState; } };
    const mode = consentMode || 'stub';
    if (mode === 'stub') W.NBDPaperCert = stubModule;
    if (mode === 'loader') W.ScriptLoader = { load: async (p) => { loads.push(p); W.NBDPaperCert = stubModule; } };
    const cp = Object.assign({}, H.profileFor(W, H.BIZ_ADDR), { paymentTerms: { deckingPerSheetCents: 10000 } });
    const v = H.VARIANTS.oh_cash;
    W._legal = () => cp; W._leadDoc = { id: 'L1', address: v.address, jobType: v.jobType };
    await W.NBDDocGen.generate(type, Object.assign(H.contractData(W, v), { companyProfile: cp, signers }));
    await new Promise((r) => setTimeout(r, 30));
    return { viewer, calls, updates, W, consentState, mounts, loads };
  };
  const HO_REP = [{ role: 'homeowner', label: 'Homeowner', required: true }, { role: 'rep', label: 'Authorized NBD Representative', required: true }];
  { const g = await genSigned(true, 'contract', HO_REP);
    ok('flag on: a contract with signers asks for the tick, with the registry\'s ESIGN-1 sentence', !!g.viewer && !!g.viewer.consent
      && g.viewer.consent.label === 'I agree to sign electronically' && g.viewer.consent.text === esignFromPacket, g.viewer && JSON.stringify(g.viewer.consent));
    const signed = '<html><body><div data-nbd-sig="homeowner" data-nbd-sig-finalized="1"></div></body></html>';
    ok('the bar is mounted over the viewer that just opened, with the same consent', g.mounts.length === 1 && g.mounts[0].text === esignFromPacket);
    g.consentState.agreed = true; // the homeowner ticks
    await g.viewer.onPersistFinalized(signed, [{ role: 'homeowner', label: 'Homeowner', signedAt: '2026-11-18T15:00:00Z', png: 'data:image/png;base64,AA' }]);
    const rec = g.calls.find((c) => c.name === 'recordInPersonSignature');
    ok('ticked: the in-person record call carries consentTick', !!rec && rec.payload.consentTick === true, JSON.stringify(g.calls));
    ok('ticked: the document is saved as signed', g.updates.some((u) => u.patch && u.patch.status === 'signed')); }
  { const g = await genSigned(true, 'contract', HO_REP);
    const signed = '<html><body><div data-nbd-sig="homeowner" data-nbd-sig-finalized="1"></div></body></html>';
    await g.viewer.onPersistFinalized(signed, [{ role: 'homeowner', label: 'Homeowner', signedAt: '2026-11-18T15:00:00Z', png: 'data:image/png;base64,AA' }]);
    ok('not ticked: nothing is saved as signed (signing is blocked without the tick)', !g.updates.some((u) => u.patch && u.patch.status === 'signed') && !g.calls.some((c) => c.name === 'recordInPersonSignature'), JSON.stringify(g.updates.map((u) => u.patch && u.patch.status)));
    g.consentState.agreed = false;
    await g.viewer.onPersistFinalized(signed, [{ role: 'homeowner', label: 'Homeowner', signedAt: '2026-11-18T15:00:00Z', png: 'data:image/png;base64,AA' }]);
    ok('ticked then unticked: still not saved', !g.updates.some((u) => u.patch && u.patch.status === 'signed')); }
  { const g = await genSigned(true, 'contract', HO_REP, 'none');
    const signed = '<html><body><div data-nbd-sig="homeowner" data-nbd-sig-finalized="1"></div></body></html>';
    await g.viewer.onPersistFinalized(signed, [{ role: 'homeowner', label: 'Homeowner', signedAt: '2026-11-18T15:00:00Z', png: 'data:image/png;base64,AA' }]);
    ok('the consent module never loaded: fail closed, nothing saved as signed', !g.updates.some((u) => u.patch && u.patch.status === 'signed')); }
  { const g = await genSigned(true, 'contract', HO_REP, 'loader');
    ok('the consent module is loaded on demand with ScriptLoader.load before the viewer opens', g.loads.length === 1 && g.loads[0] === 'js/paper-cert.js?v=1' && g.mounts.length === 1, JSON.stringify(g.loads)); }
  { const g = await genSigned(false, 'contract', HO_REP);
    ok('flag off: no consent bar is requested', !!g.viewer && !('consent' in g.viewer));
    const signed = '<html><body><div data-nbd-sig="homeowner" data-nbd-sig-finalized="1"></div></body></html>';
    await g.viewer.onPersistFinalized(signed, [{ role: 'homeowner', label: 'Homeowner', signedAt: '2026-11-18T15:00:00Z', png: 'data:image/png;base64,AA' }]);
    const rec = g.calls.find((c) => c.name === 'recordInPersonSignature');
    ok('flag off: signing saves as before and the call has no consentTick', g.updates.some((u) => u.patch && u.patch.status === 'signed') && !!rec && !('consentTick' in rec.payload), JSON.stringify(rec)); }
  { const g = await genSigned(true, 'contract', [{ role: 'rep', label: 'Rep', required: true }]);
    ok('flag on, a rep-only document: no homeowner tick', !!g.viewer && !('consent' in g.viewer)); }

  section('4. the server records the tick as the evidence consent, not "not asked"');
  { const DE = require(path.join(FN, 'doc-evidence.js')); const Lg = require(path.join(FN, 'in-person-signing-logic.js'));
    const P = 'documents/U1/L1/d-1.html';
    const mkDb = (lead) => kit.makeDb({ 'leads/L1': lead, 'leads/L1/documents/d1': { type: 'work_authorization', status: 'signed', signedAt: { toMillis: () => 1 }, signers: [{ role: 'homeowner', required: true }], signedSigners: [{ role: 'homeowner' }], htmlPath: P } });
    const run = async (clauseFlag, data, lead) => {
      const db = mkDb(lead || { userId: 'U1', companyId: 'U1' });
      return Lg.recordEvidence(db, { leadId: 'L1', docId: 'd1', lead: lead || { userId: 'U1', companyId: 'U1' }, docMeta: db._get('leads/L1/documents/d1'), uid: 'U1', data: data || {} },
        { enabled: true, clauseFlag, ip: '203.0.113.5', ipSource: 'socket', ua: 'UA', readBytes: async () => Buffer.from('<html><body>signed</body></html>') });
    };
    const CSserver = require(path.join(FN, 'clause-set.js'));
    let r = await run(true, { consentTick: true });
    ok('flag on + tick: consent agreed, with the server\'s own copy of the ESIGN-1 sentence', r.consent.agreed === true && r.consent.text === CSserver.esignConsentText(false) && r.consent.text === esignFromPacket.replace(/\bNBD\b/g, 'Contractor'), JSON.stringify(r.consent).slice(0, 120));
    ok('flag on + tick: the source is in_person_tick and the time is recorded', r.consentSource === 'in_person_tick' && Number.isFinite(r.consent.at), JSON.stringify({ s: r.consentSource, at: r.consent.at }));
    r = await run(true, {});
    ok('flag on, no tick sent: still recorded as not asked', r.consent.agreed === null && !('consentSource' in r && r.consentSource === 'in_person_tick'));
    r = await run(false, { consentTick: true });
    ok('flag off: a tick the call claims is ignored (not asked, as before)', r.consent.agreed === null && r.consentSource === undefined, JSON.stringify(r.consent));
    r = await run(true, { consentTick: 'yes' });
    ok('a non-boolean tick is not a tick', r.consent.agreed === null);
    const nbd = await run(true, { consentTick: true }, { userId: DE.NBD_OWNER_UID_FOR_TESTS, companyId: DE.NBD_OWNER_UID_FOR_TESTS });
    ok('the NBD tenant reads the sentence with NBD verbatim', nbd.consent.text === esignFromPacket, nbd.consent.text && nbd.consent.text.slice(0, 60)); }

  console.log('\npaper-cert-signers: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log(fails.join('\n')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
