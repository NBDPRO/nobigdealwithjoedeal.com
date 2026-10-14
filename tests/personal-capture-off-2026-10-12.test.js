/**
 * tests/personal-capture-off-2026-10-12.test.js — phase 2c: a number Jo labeled
 * PERSONAL and confirmed "stop copying and transcribing" is not copied, not
 * transcribed, and its texts are not stored.
 *
 *   A. server: functions/contact-labels.js captureOff / loadLabels
 *   B. call ingest: a labeled number is listed (cursor advances, one metadata
 *      row) but nothing is downloaded, uploaded, transcribed or noted
 *   C. transcribe: an already-stored, not-yet-transcribed call from such a
 *      number is not transcribed and its audio is left exactly as it is
 *   D. text ingest: the message (body) is never written
 *   E. client: the label doc only carries capture on personal; the sheet asks
 *      first; the rules accept exactly that
 *
 * Every absence assertion has a positive control (same input, no label).
 * Numbers are 555 fixtures. Run: node tests/personal-capture-off-2026-10-12.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + detail : '')); }
}

const CL = require(path.join(ROOT, 'functions/contact-labels.js'));
const M = require(path.join(ROOT, 'functions/call-center.js'));
const { runIngest, runTranscribe, setClient, OWNER, COLLECTION } = M._test;
const LG = require(path.join(ROOT, 'docs/pro/js/contact-labels-logic.js'));

const FOLDER = 'application/vnd.google-apps.folder';
const PERSONAL = '5550147777';
function fakeDrive() {
  const tree = {
    root: [{ id: 'd30', name: '2026-09-30', mimeType: FOLDER }],
    d30: [
      { id: 'p1', name: '2026-09-30 15-47-26 (phone) Mom (+1 555-014-7777) ↙.m4a', size: '2000', mimeType: 'audio/mpeg' },
      { id: 'f3', name: '2026-09-30 17-12-33 (phone) +1 800-555-1370 ↙.m4a', size: '3000', mimeType: 'audio/mpeg' },
    ],
  };
  const downloads = [];
  return {
    downloads,
    request: async (o) => {
      if (o.params && o.params.alt === 'media') {
        const id = decodeURIComponent(o.url.split('/files/')[1]);
        downloads.push(id);
        return { data: new Uint8Array([1, 2, 3]).buffer };
      }
      const q = o.params.q;
      if (/^name = 'Cube ACR'/.test(q)) return { data: { files: [{ id: 'root', name: 'Cube ACR' }] } };
      const parent = /^'([^']+)' in parents/.exec(q)[1];
      return { data: { files: (tree[parent] || []).filter((f) => !/mimeType = /.test(q) || f.mimeType === FOLDER) } };
    },
  };
}
function fakeDb({ labels = [], labelsThrow = false, docs: seed, leads = [] } = {}) {
  const leadsSnap = { forEach: (fn) => leads.forEach((l) => fn({ id: l.id, data: () => l })), docs: leads.map((l) => ({ id: l.id, data: () => l })) };
  const docs = new Map(seed || []);
  const mk = (p) => ({
    id: p.split('/').pop(), path: p,
    async get() { return { exists: docs.has(p), id: p.split('/').pop(), data: () => docs.get(p) }; },
    async set(v, opt) { docs.set(p, opt && opt.merge ? Object.assign({}, docs.get(p) || {}, v) : v); },
  });
  const labelsCol = { get: async () => { if (labelsThrow) throw new Error('boom'); return { docs: labels.map((l) => ({ id: l.id, data: () => l })) }; } };
  return {
    docs,
    doc: (p) => mk(p),
    collection: (name) => ({
      doc: (id) => (name === 'companies' ? { collection: () => labelsCol } : mk(name + '/' + id)),
      where: () => ({ get: async () => leadsSnap, where: () => ({ orderBy: () => ({ limit: () => ({ get: async () => ({ forEach: () => {} }) }) }) }) }),
    }),
    getAll: async (...refs) => Promise.all(refs.map((r) => r.get())),
  };
}
function fakeBucket() {
  const saved = new Map(), deleted = [];
  return { saved, deleted, file: (p) => ({ save: async (b) => { saved.set(p, b.length); }, delete: async () => { deleted.push(p); } }) };
}
const NOW = Date.parse('2026-10-01T12:00:00Z');
const callDocs = (db) => [...db.docs.keys()].filter((k) => k.startsWith(COLLECTION + '/'));
const labelDoc = (extra) => Object.assign({ id: PERSONAL, kind: 'personal', policy: 'hide', capture: 'off', updatedAtMs: NOW - 86400000 }, extra || {});

(async () => {
  console.log('A. server helper');
  ok('captureOff needs personal AND capture off', CL.captureOff({ [PERSONAL]: { kind: 'personal', capture: 'off' } }, '(555) 014-7777') === true
    && CL.captureOff({ [PERSONAL]: { kind: 'personal', capture: '' } }, PERSONAL) === false
    && CL.captureOff({ [PERSONAL]: { kind: 'spam', capture: 'off' } }, PERSONAL) === false
    && CL.captureOff({}, PERSONAL) === false && CL.captureOff(null, PERSONAL) === false && CL.captureOff({ [PERSONAL]: { kind: 'personal', capture: 'off' } }, '') === false);
  const loaded = await CL.loadLabels(fakeDb({ labels: [labelDoc(), { id: 'abc', kind: 'personal' }, { id: '5550149999' }] }), OWNER);
  ok('loadLabels indexes valid ids with a kind, keeps capture', Object.keys(loaded).join() === PERSONAL && loaded[PERSONAL].capture === 'off', JSON.stringify(loaded));
  ok('loadLabels: a failed read is {} (fails toward capturing)', Object.keys(await CL.loadLabels(fakeDb({ labelsThrow: true }), OWNER)).length === 0);

  console.log('B. call ingest');
  const drive = fakeDrive(); setClient(drive);
  let db = fakeDb({ labels: [labelDoc()] }), bucket = fakeBucket();
  let r = await runIngest({ db, bucket, live: true, nowMs: NOW });
  const ids = callDocs(db);
  const pDoc = [...db.docs.entries()].find(([k, v]) => k.startsWith(COLLECTION + '/') && v.phoneDigits === PERSONAL);
  const other = [...db.docs.entries()].find(([k, v]) => k.startsWith(COLLECTION + '/') && v.phoneDigits === '8005551370');
  ok('both recordings are filed once; the personal one is counted as label-skipped', ids.length === 2 && r.labelSkipped === 1, JSON.stringify(r));
  ok('the personal call is a metadata row only: status personal, no storagePath, audioRemoved "label", no transcript',
    !!pDoc && pDoc[1].status === 'personal' && pDoc[1].storagePath === null && pDoc[1].audioRemoved === 'label' && !pDoc[1].transcript && pDoc[1].startedAtMs > 0, JSON.stringify(pDoc && pDoc[1]));
  ok('its audio was NOT downloaded and NOT uploaded; the other call was', !drive.downloads.includes('p1') && drive.downloads.includes('f3') && bucket.saved.size === 1);
  ok('the other call is stored normally (positive control)', !!other && other[1].status === 'stored' && !!other[1].storagePath);
  ok('a re-run files nothing twice', (await runIngest({ db, bucket, live: true, nowMs: NOW })).fresh === 0);
  const drive2 = fakeDrive(); setClient(drive2);
  const dbC = fakeDb({ labels: [] }), bucketC = fakeBucket();
  await runIngest({ db: dbC, bucket: bucketC, live: true, nowMs: NOW });
  ok('control: with NO label the same recording is downloaded and stored', drive2.downloads.includes('p1') && bucketC.saved.size === 2);
  const drive3 = fakeDrive(); setClient(drive3);
  const dbK = fakeDb({ labels: [labelDoc({ capture: '' })] }), bucketK = fakeBucket();
  await runIngest({ db: dbK, bucket: bucketK, live: true, nowMs: NOW });
  ok('control: personal WITHOUT capture off (hide only) still copies it', drive3.downloads.includes('p1') && bucketK.saved.size === 2);
  const drive4 = fakeDrive(); setClient(drive4);
  const dbE = fakeDb({ labelsThrow: true }), bucketE = fakeBucket();
  await runIngest({ db: dbE, bucket: bucketE, live: true, nowMs: NOW });
  ok('a failed labels read copies everything (fail toward capturing)', drive4.downloads.includes('p1') && bucketE.saved.size === 2);
  const drive5 = fakeDrive(); setClient(drive5);
  const dbD = fakeDb({ labels: [labelDoc()] });
  const rd = await runIngest({ db: dbD, bucket: fakeBucket(), live: false, nowMs: NOW });
  ok('a dry run counts the skip and writes nothing', rd.labelSkipped === 1 && callDocs(dbD).length === 0 && drive5.downloads.length === 0);

  // Audit C-4 (2026-10-13): a number that BECAME a customer after the label is captured.
  {
    const ts = (ms) => ({ toMillis: () => ms });
    const newLead = { id: 'L-new', userId: OWNER, companyId: OWNER, firstName: 'Mo', lastName: 'Example', phone: '(555) 014-7777', createdAt: ts(NOW - 3600000) };
    const oldLead = Object.assign({}, newLead, { id: 'L-old', createdAt: ts(NOW - 30 * 86400000) });
    const dr = fakeDrive(); setClient(dr);
    const dbN = fakeDb({ labels: [labelDoc({ updatedAtMs: NOW - 86400000 })], leads: [newLead] }), bkN = fakeBucket();
    await runIngest({ db: dbN, bucket: bkN, live: true, nowMs: NOW });
    const nDoc = [...dbN.docs.entries()].find(([k, v]) => k.startsWith(COLLECTION + '/') && v.phoneDigits === PERSONAL);
    ok('a customer created AFTER the label: the number is downloaded and stored again (status stored, leadId set)',
      dr.downloads.includes('p1') && !!nDoc && nDoc[1].status === 'stored' && nDoc[1].leadId === 'L-new', JSON.stringify(nDoc && nDoc[1]));
    const dr2 = fakeDrive(); setClient(dr2);
    const dbO = fakeDb({ labels: [labelDoc({ updatedAtMs: NOW - 86400000 })], leads: [oldLead] }), bkO = fakeBucket();
    await runIngest({ db: dbO, bucket: bkO, live: true, nowMs: NOW });
    ok('control: a customer that existed BEFORE the label keeps capture off (Jo saw "On customer" when he chose it)', !dr2.downloads.includes('p1') && bkO.saved.size === 1);
    const dr3 = fakeDrive(); setClient(dr3);
    const dbA = fakeDb({ labels: [labelDoc({ updatedAtMs: NOW - 86400000, ackAtMs: NOW - 60000 })], leads: [newLead] }), bkA = fakeBucket();
    await runIngest({ db: dbA, bucket: bkA, live: true, nowMs: NOW });
    ok('control: "Keep it off" (ackAtMs after the customer appeared) restores capture off', !dr3.downloads.includes('p1') && bkA.saved.size === 1);
  }

  console.log('C. transcribe queue');
  const stored = { userId: OWNER, companyId: OWNER, status: 'stored', phoneDigits: PERSONAL, storagePath: 'calls/x/cube-acr/2026-09-30/cube_p.m4a', startedAtMs: NOW - 3600000, sizeBytes: 10 };
  ok('runTranscribe is exported for the test', typeof runTranscribe === 'function');
  if (typeof runTranscribe === 'function') {
    const qdb = fakeDb({ labels: [labelDoc()], docs: [[COLLECTION + '/cube_p', stored]] });
    // allowIds path: the queue reads exactly the named docs (no query needed).
    qdb.docs.set('integrations/callCenter', { transcribeOnly: ['cube_p'] });
    const rb = fakeBucket();
    let transcribed = false;
    const rr = await runTranscribe({ db: qdb, bucket: rb, live: true, nowMs: NOW }).catch((e) => ({ error: String(e && e.message) }));
    const after = qdb.docs.get(COLLECTION + '/cube_p');
    ok('the queued call from the labeled number is NOT picked, its status moves to personal, its storagePath is kept',
      after.status === 'personal' && after.labelCapture === 'off' && after.storagePath === stored.storagePath && rb.deleted.length === 0 && !after.transcript && !(rr && rr.error),
      JSON.stringify({ after, rr }));

    // positive control: the same queued call with NO label is picked (it fails in
    // this fake bucket, which proves the queue DID try to read its audio)
    const cdb = fakeDb({ labels: [], docs: [[COLLECTION + '/cube_p', stored]] });
    cdb.docs.set('integrations/callCenter', { transcribeOnly: ['cube_p'] });
    const cr = await runTranscribe({ db: cdb, bucket: fakeBucket(), live: true, nowMs: NOW }).catch((e) => ({ error: String(e && e.message) }));
    const cafter = cdb.docs.get(COLLECTION + '/cube_p');
    ok('control: with no label the same call IS picked by the queue (not marked personal by a label)', cafter.labelCapture !== 'off' && (cr.picked === 1 || cr.failed >= 1 || cafter.transcribeAttempts > 0), JSON.stringify({ cr, cafter }));
  }

  // C-4 in the transcribe queue: a number that became a customer after its label is
  // transcribed; one whose customer predates the label is still marked personal.
  if (typeof runTranscribe === 'function') {
    const ts = (ms) => ({ toMillis: () => ms });
    const mkLead = (id, createdMs) => ({ id, userId: OWNER, companyId: OWNER, firstName: 'Mo', lastName: 'Example', phone: '(555) 014-7777', createdAt: ts(createdMs) });
    const run = async (leads, lbl) => {
      const d = fakeDb({ labels: [lbl || labelDoc({ updatedAtMs: NOW - 86400000 })], leads, docs: [[COLLECTION + '/cube_p', stored]] });
      d.docs.set('integrations/callCenter', { transcribeOnly: ['cube_p'] });
      await runTranscribe({ db: d, bucket: fakeBucket(), live: true, nowMs: NOW }).catch(() => null);
      return d.docs.get(COLLECTION + '/cube_p');
    };
    const aNew = await run([mkLead('L-new', NOW - 3600000)]);
    ok('transcribe: a customer created AFTER the label keeps the stored call in the queue (not marked personal)', aNew.status !== 'personal' && aNew.labelCapture !== 'off', JSON.stringify(aNew));
    const aOld = await run([mkLead('L-old', NOW - 30 * 86400000)]);
    ok('transcribe control: a customer that PREDATES the label is still marked personal', aOld.status === 'personal' && aOld.labelCapture === 'off', JSON.stringify(aOld));
    const aAck = await run([mkLead('L-new', NOW - 3600000)], labelDoc({ updatedAtMs: NOW - 86400000, ackAtMs: NOW - 60000 }));
    ok('transcribe control: Keep-it-off after the customer appeared marks it personal again', aAck.status === 'personal', JSON.stringify(aAck));
    const aDel = await run([Object.assign(mkLead('L-del', NOW - 3600000), { deleted: true })]);
    ok('transcribe: a DELETED new lead is not a customer (still personal)', aDel.status === 'personal', JSON.stringify(aDel));
  }

  console.log('D. text ingest');
  {
    // Behavioural text-ingest cases (replaces the source-regex pin, which a comment could satisfy).
    const TM = require(path.join(ROOT, 'functions/text-inbox.js'))._test;
    const ts2 = (ms) => ({ toMillis: () => ms });
    const xml = '<smses><sms protocol="0" address="+15550147777" date="' + (NOW - 2 * 3600000) + '" type="1" body="hello there" contact_name="Mom" /></smses>';
    const F = { id: 'tb1', name: 'sms-20261001100000.xml', size: '900', modifiedTime: '2026-10-01T10:00:00Z' };
    const mkDrive = () => ({ request: async (o) => {
      if (o.params && o.params.alt === 'media') return { data: new TextEncoder().encode(xml).buffer };
      if (/^name = 'SMSBackupRestore'/.test(o.params.q)) return { data: { files: [{ id: 'fold', name: 'SMSBackupRestore' }] } };
      return { data: { files: [F] } };
    } });
    const mkDb = (lbl, leads) => {
      const docs = new Map();
      const mk = (p) => ({ id: p.split('/').pop(), _p: p,
        get: async () => ({ exists: docs.has(p), id: p.split('/').pop(), data: () => docs.get(p) }),
        set: async (v, o) => { docs.set(p, o && o.merge ? Object.assign({}, docs.get(p) || {}, v) : v); } });
      return { docs, doc: mk,
        collection: (n) => ({
          doc: (id) => (n === 'companies' ? { collection: () => ({ get: async () => ({ docs: [{ id: PERSONAL, data: () => lbl }] }) }) } : mk(n + '/' + id)),
          where: (f, _o, v) => ({ get: async () => { const rows = n === 'leads' ? leads.filter((l) => l[f] === v) : []; return { forEach: (fn) => rows.forEach((l) => fn({ id: l.id, data: () => l })) }; } }),
        }),
        getAll: async (...refs) => Promise.all(refs.map((r) => r.get())),
        batch: () => { const ops = []; return { set: (r, v) => ops.push([r._p, v]), commit: async () => { ops.forEach(([p, v]) => docs.set(p, v)); } }; } };
    };
    const stored2 = (d) => [...d.docs.keys()].filter((k) => k.startsWith(TM.COLLECTION + '/')).length;
    const lead = (id, ms) => ({ id, userId: TM.OWNER, companyId: TM.OWNER, phone: '(555) 014-7777', createdAt: ts2(ms) });
    const lbl = labelDoc({ updatedAtMs: NOW - 86400000 });
    TM.setClient(mkDrive());
    const dNew = mkDb(lbl, [lead('Ln', NOW - 3600000)]);
    await TM.runTextIngest({ db: dNew, live: true, nowMs: NOW });
    ok('text ingest: a customer created AFTER the label -> the text IS stored', stored2(dNew) === 1);
    const dOld = mkDb(lbl, [lead('Lo', NOW - 30 * 86400000)]);
    TM.setClient(mkDrive());
    await TM.runTextIngest({ db: dOld, live: true, nowMs: NOW });
    ok('text ingest control: a customer that PREDATES the label -> NOT stored', stored2(dOld) === 0);
    const dNone = mkDb(lbl, []);
    TM.setClient(mkDrive());
    await TM.runTextIngest({ db: dNone, live: true, nowMs: NOW });
    ok('text ingest control: no customer -> NOT stored (capture off)', stored2(dNone) === 0);
    const dNoLabel = mkDb({ id: PERSONAL, kind: 'personal', policy: 'hide', capture: '', updatedAtMs: 1 }, []);
    TM.setClient(mkDrive());
    await TM.runTextIngest({ db: dNoLabel, live: true, nowMs: NOW });
    ok('text ingest positive control: same text with capture NOT off IS stored', stored2(dNoLabel) === 1);
  }

  console.log('E. client + rules');
  const base = { digits: PERSONAL, companyId: 'co', uid: 'u', nowMs: NOW };
  ok('buildDoc: capture off is carried ONLY on personal', LG.buildDoc(Object.assign({ kind: 'personal', capture: 'off' }, base)).capture === 'off'
    && LG.buildDoc(Object.assign({ kind: 'spam', capture: 'off' }, base)).capture === undefined
    && LG.buildDoc(Object.assign({ kind: 'personal' }, base)).capture === undefined
    && LG.buildDoc(Object.assign({ kind: 'personal', capture: 'on' }, base)).capture === undefined);
  ok('indexLabels reads capture only on personal', LG.indexLabels([{ id: PERSONAL, data: { kind: 'personal', capture: 'off' } }])[PERSONAL].capture === 'off'
    && LG.indexLabels([{ id: PERSONAL, data: { kind: 'spam', capture: 'off' } }])[PERSONAL].capture === '');
  ok('the chip says "not recorded"', LG.chipFor({ kind: 'personal', policy: 'hide', capture: 'off' }).text === 'Personal · hidden number · not recorded');
  const rules = read('firestore.rules');
  ok('rules: capture only "off", only on personal', /d\.capture == 'off' && d\.kind == 'personal'/.test(rules) && /'ackAtMs', 'capture'\]/.test(rules));
  const ui = read('docs/pro/js/contact-labels.js');
  ok('the sheet asks before anything stops: a first Personal pick shows the confirm, with what stays untouched',
    /confirmPersonal\(s\); return;/.test(ui) && /Calls and texts already in the CRM stay exactly as they are/.test(ui)
    && /data-cl="personal-hide"/.test(ui) && /data-cl="personal-stop"/.test(ui));
  ok('a policy tap on an existing label keeps its capture setting', /capture === undefined && before && before\.kind === kind\) capture = before\.capture/.test(ui));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
