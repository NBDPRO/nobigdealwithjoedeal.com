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

  console.log('\npaper-cert-signers: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log(fails.join('\n')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
