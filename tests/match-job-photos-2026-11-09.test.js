/**
 * tests/match-job-photos-2026-11-09.test.js
 *
 * scripts/match-job-photos.js (CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09 §1
 * steps 1-2): Jo runs it on his own computer over a folder of job photos.
 * Dry run: each photo is scored against each 2026 lead (street key from the
 * lead address, EXIF date against the lead's stage windows, EXIF GPS against
 * the lead's lat/lng) and a review CSV + a local, script-free HTML contact
 * sheet are written OUTSIDE docs/. --apply <reviewed csv> files each approved
 * row create-only (Storage ifGenerationMatch=0, Firestore create()), and
 * writes nothing without --yes.
 *
 *   1. addrKey / addrKeysInFilename exported from the audit script, unchanged.
 *   2. Phase windows from stageHistory, with social-studio.js's fallbacks.
 *   3. Scoring; a street key ALONE never matches; far GPS disqualifies.
 *   4. CSV round trip (quotes, commas, newlines, BOM, CRLF, formula guard).
 *   5. A real dry run over synthetic EXIF JPEGs: CSV + HTML, no network, no
 *      customer name / address / file name on stdout, no <script>.
 *   6. --apply: dry by default, without --yes nothing is written; with --yes
 *      only approved rows, create-only, the photo-engine.js row shape,
 *      a rerun overwrites nothing; every refusal (sha, HEIC, lead, tenant).
 *   7. The REST Storage client: ifGenerationMatch=0, 412 -> already-exists.
 *   8. The phase stage lists match photo-engine.js.
 *   9. Review fixes (2026-11-09): a backfilled job ends at completedAt; a
 *      directional prefix is not the street word; --out stays out of the repo;
 *      --uid must belong to --company; the /photos row is written before the
 *      upload (so image-pipeline.js finds it); no EXIF date is not "today";
 *      token mode reads only the company's leads (no collection-group scan).
 *
 * Synthetic data only. No network.
 * Run: node tests/match-job-photos-2026-11-09.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
async function guard(name, fn) {
  console.log(name);
  try { await fn(); } catch (e) { ok(name + ' ran without throwing', false, String(e && e.stack || e).split('\n').slice(0, 4).join(' | ')); }
}

// ── A minimal JPEG: SOI, APP1 Exif (DateTimeOriginal + GPS), EOI ──
// (the same builder as tests/photo-exif-capture-2026-11-09.test.js)
function exifJpeg(o) {
  o = o || {};
  const dt = o.date || '2026:05:13 09:24:30';
  const t = Buffer.alloc(178);
  t.write('II', 0, 'latin1'); t.writeUInt16LE(42, 2); t.writeUInt32LE(8, 4);
  let p = 8;
  const entry = (tag, type, count, val) => { t.writeUInt16LE(tag, p); t.writeUInt16LE(type, p + 2); t.writeUInt32LE(count, p + 4); t.writeUInt32LE(val, p + 8); p += 12; };
  const ascii2 = (tag, ch) => { t.writeUInt16LE(tag, p); t.writeUInt16LE(2, p + 2); t.writeUInt32LE(2, p + 4); t.write(ch, p + 8, 'latin1'); p += 12; };
  t.writeUInt16LE(o.noGps ? 1 : 2, p); p += 2; entry(0x8769, 4, 1, 38); if (!o.noGps) entry(0x8825, 4, 1, 56); else p += 12; t.writeUInt32LE(0, p); p += 4;
  t.writeUInt16LE(1, p); p += 2; entry(0x9003, 2, 20, 110); t.writeUInt32LE(0, p); p += 4;
  t.writeUInt16LE(4, p); p += 2;
  ascii2(1, 'N'); entry(2, 5, 3, 130); ascii2(3, 'W'); entry(4, 5, 3, 154); t.writeUInt32LE(0, p); p += 4;
  t.write(dt.slice(0, 19) + '\0', 110, 'latin1');
  const rat = (off, arr) => arr.forEach((v, i) => { t.writeUInt32LE(v, off + i * 8); t.writeUInt32LE(1, off + i * 8 + 4); });
  rat(130, o.lat || [39, 6, 0]); rat(154, o.lng || [84, 30, 0]);
  const app1 = Buffer.concat([Buffer.from([0xFF, 0xE1, 0, 0]), Buffer.from('Exif\0\0', 'latin1'), t]);
  app1.writeUInt16BE(app1.length - 2, 2);
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), app1, Buffer.from([0xFF, 0xD9])]);
}

const DAY = 86400000;
const L = (y, m, d, h, mi) => new Date(y, m - 1, d, h || 0, mi || 0).getTime();
const iso = (ms) => new Date(ms).toISOString();

// Lead A: install started 2026-05-13 08:00, completed 2026-05-14 15:00, at 39.1,-84.5.
const LEAD_A = {
  id: 'leadA', companyId: 'co1', firstName: 'NAMESECRET', lastName: 'Alpha',
  address: '1004 Larkspur Dr, Maineville, OH 45039', lat: 39.1, lng: -84.5,
  createdAt: iso(L(2026, 4, 20)), stage: 'install_complete',
  stageHistory: [
    { from: 'new', to: 'contract_signed', timestamp: iso(L(2026, 5, 1, 10)) },
    { from: 'contract_signed', to: 'install_in_progress', timestamp: iso(L(2026, 5, 13, 8)) },
    { from: 'install_in_progress', to: 'install_complete', timestamp: iso(L(2026, 5, 14, 15)) },
  ],
};
// Lead B: same number, another street, far away; done in 2026-08.
const LEAD_B = {
  id: 'leadB', companyId: 'co1', firstName: 'NAMESECRET', lastName: 'Bravo',
  address: '77 Oak Hill Rd, Mason, OH', lat: 39.4, lng: -84.3,
  createdAt: iso(L(2026, 7, 1)), stage: 'install_complete', installCompletedAt: iso(L(2026, 8, 10, 16)),
  stageHistory: [{ from: 'new', to: 'install_complete', timestamp: iso(L(2026, 8, 10, 16)) }],
};
const LEAD_OLD = { id: 'leadOld', companyId: 'co1', firstName: 'Old', address: '5 Elm St', createdAt: iso(L(2025, 3, 1)), stageHistory: [] };
const LEAD_OTHER = { id: 'leadOther', companyId: 'co2', firstName: 'Other', address: '1004 Larkspur Dr', createdAt: iso(L(2026, 5, 1)), lat: 39.1, lng: -84.5 };

(async () => {
  const S_PATH = path.join(ROOT, 'scripts', 'match-job-photos.js');
  if (!fs.existsSync(S_PATH)) {
    ok('scripts/match-job-photos.js exists', false);
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exit(1);
  }
  const S = require(S_PATH);
  const R = require(path.join(ROOT, 'scripts', '_firestore-rest.js'));
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nbd-photo-match-test-'));

  await guard('1. street keys come from the audit script, unchanged', async () => {
    const A = require(path.join(ROOT, 'scripts', 'audit-imported-docs-placement.js'));
    ok('requiring the audit script does not run it (no --company exit)', typeof A.addrKey === 'function' && typeof A.addrKeysInFilename === 'function');
    ok('addrKey keeps its output', A.addrKey('1004 Larkspur Dr, Maineville, OH 45039') === '1004 larkspur dr', A.addrKey('1004 Larkspur Dr, Maineville, OH 45039'));
    ok('addrKeysInFilename keeps its output', JSON.stringify(A.addrKeysInFilename('Full Report - 1004 Larkspur Dr.pdf')) === JSON.stringify(['1004 larkspur dr']));
    ok('the matcher uses the same functions', S.addrKey === A.addrKey && S.addrKeysInFilename === A.addrKeysInFilename);
  });

  await guard('2. phase windows from stageHistory, with fallbacks', async () => {
    const w = S.leadWindows(LEAD_A);
    ok('install start = first move onto install_in_progress', w.start === L(2026, 5, 13, 8));
    ok('install end = first move onto install_complete', w.end === L(2026, 5, 14, 15));
    ok('a photo days before the install is Before', S.phaseFor(L(2026, 5, 10, 12), w) === 'Before');
    ok('a photo early on the install morning is During (day granularity)', S.phaseFor(L(2026, 5, 13, 6), w) === 'During');
    ok('a photo between start and completion is During', S.phaseFor(L(2026, 5, 14, 9), w) === 'During');
    ok('a photo after completion is After', S.phaseFor(L(2026, 5, 14, 17), w) === 'After');
    ok('no date: no phase', S.phaseFor(null, w) === null);

    const wb = S.leadWindows(LEAD_B);
    ok('installCompletedAt wins as the end', wb.end === L(2026, 8, 10, 16));
    ok('one-day job (no start): the completion day is During', S.phaseFor(L(2026, 8, 10, 9), wb) === 'During' && S.phaseFor(L(2026, 8, 9, 9), wb) === 'Before' && S.phaseFor(L(2026, 8, 11, 9), wb) === 'After');

    const wc = S.leadWindows({ completedAt: { seconds: L(2026, 6, 2, 12) / 1000 } });
    ok('completedAt (a Timestamp) is the next fallback', wc.end === L(2026, 6, 2, 12));
    const wd = S.leadWindows({ stage: 'final_payment', stageStartedAt: iso(L(2026, 6, 5)) });
    ok('stageStartedAt counts only when the lead stands on an after stage', wd.end === L(2026, 6, 5));
    const we = S.leadWindows({ stage: 'estimate_sent', stageStartedAt: iso(L(2026, 6, 5)) });
    ok('…a before stage gives no end', !we.end && S.phaseFor(L(2026, 6, 6), we) === null);
    const wf = S.leadWindows({ stage: 'final_payment', updatedAt: iso(L(2026, 6, 7)) });
    ok('updatedAt is the last fallback (social-studio.js order)', wf.end === L(2026, 6, 7));
    // stage-write.js's quiet "already completed" backfill: the history event is
    // stamped at click time (backfill: true) and the real day is in completedAt.
    const wq = S.leadWindows({ completedAt: iso(L(2026, 6, 2, 12)), stageHistory: [{ to: 'install_complete', timestamp: iso(L(2026, 11, 1, 9)), backfill: true, completedOn: '2026-06-02' }] });
    ok('a backfilled completion uses completedAt, not the click time', wq.end === L(2026, 6, 2, 12) && wq.last === L(2026, 6, 2, 12), JSON.stringify(wq));
    const lostAfter = S.leadWindows({ stageHistory: [{ to: 'lost', timestamp: iso(L(2026, 6, 1)) }] });
    ok('a move to lost is not an install end', !lostAfter.end);

    ok('inYear: a 2026 lead counts', S.inYear(LEAD_A, 2026) && S.inYear(LEAD_B, 2026));
    ok('inYear: a 2025-only lead does not', !S.inYear(LEAD_OLD, 2026));
  });

  await guard('3. scoring: never on the street key alone', async () => {
    const wA = S.leadWindows(LEAD_A);
    const streetOnly = S.scorePhotoLead({ relPath: '1004 Larkspur Dr/IMG_0001.jpg', takenMs: null, gps: null }, LEAD_A, wA);
    ok('street key alone: no match', streetOnly.match === false && streetOnly.kinds.includes('street'), JSON.stringify(streetOnly));
    const streetWrongDate = S.scorePhotoLead({ relPath: '1004 Larkspur Dr/IMG_0001.jpg', takenMs: L(2026, 1, 3), gps: null }, LEAD_A, wA);
    ok('street key + a date far outside the job: no match', streetWrongDate.match === false);
    const streetDate = S.scorePhotoLead({ relPath: '1004 Larkspur/IMG_0001.jpg', takenMs: L(2026, 5, 13, 10), gps: null }, LEAD_A, wA);
    ok('street key (number + first word) + install date: a match', streetDate.match === true && streetDate.kinds.includes('street') && streetDate.kinds.includes('date'), JSON.stringify(streetDate));
    ok('…with its phase', streetDate.phase === 'During');
    const gpsDate = S.scorePhotoLead({ relPath: 'DCIM/IMG_0002.jpg', takenMs: L(2026, 5, 14, 17), gps: { lat: 39.1003, lng: -84.5 } }, LEAD_A, wA);
    ok('GPS on site + date in the job: a match, high', gpsDate.match === true && gpsDate.confidence === 'high' && gpsDate.distanceM < 75, JSON.stringify(gpsDate));
    const gpsOnly = S.scorePhotoLead({ relPath: 'DCIM/IMG_0003.jpg', takenMs: null, gps: { lat: 39.1, lng: -84.5 } }, LEAD_A, wA);
    ok('GPS on site alone: no match', gpsOnly.match === false);
    const farGps = S.scorePhotoLead({ relPath: '1004 Larkspur Dr/IMG_0004.jpg', takenMs: L(2026, 5, 13, 10), gps: { lat: 39.3, lng: -84.5 } }, LEAD_A, wA);
    ok('GPS kilometres away disqualifies, even with street + date', farGps.match === false && farGps.disqualified === true);
    const otherStreet = S.scorePhotoLead({ relPath: '1004 Maple Ave/IMG_0005.jpg', takenMs: null, gps: null }, LEAD_A, wA);
    ok('same house number, other street: no street hit', !otherStreet.kinds.includes('street'));
    const noAddr = S.scorePhotoLead({ relPath: '1004 Larkspur/IMG.jpg', takenMs: L(2026, 5, 13, 10), gps: null }, { id: 'x' }, S.leadWindows({}));
    ok('a lead with no address or dates never matches', noAddr.match === false);

    const leads = [LEAD_A, LEAD_B].map((l) => ({ lead: l, win: S.leadWindows(l) }));
    const best = S.bestMatch({ relPath: 'x/IMG.jpg', takenMs: L(2026, 5, 14, 17), gps: { lat: 39.1, lng: -84.5 } }, leads);
    ok('bestMatch picks the lead on site at that date', best && best.lead.id === 'leadA' && !best.ambiguous);
    const twin = Object.assign({}, LEAD_A, { id: 'leadA2' });
    const tie = S.bestMatch({ relPath: 'x/IMG.jpg', takenMs: L(2026, 5, 14, 17), gps: { lat: 39.1, lng: -84.5 } }, leads.concat([{ lead: twin, win: S.leadWindows(twin) }]));
    ok('a tie with another lead is flagged ambiguous', tie && tie.ambiguous === true && tie.runnerUp && tie.runnerUp.lead.id !== tie.lead.id);
    ok('no qualifying lead: null', S.bestMatch({ relPath: 'x/IMG.jpg', takenMs: null, gps: null }, leads) === null);
  });

  await guard('4. CSV round trip', async () => {
    const rows = [
      { approve: '', phase: 'Before', leadId: 'leadA', leadName: 'O\'Neil, "Jr"', leadAddress: '1 A St,\nUnit 2', file: '/p/a,b.jpg', reasons: 'street; date', distanceM: '', gpsLat: '39.1', gpsLng: '-84.5', sha256: 'abc' },
      { approve: 'y', phase: '', leadId: 'leadB', leadName: '=HYPERLINK("x")', leadAddress: '+1 Evil', file: '/p/@b.jpg', reasons: '-cmd', gpsLng: '-84.25' },
    ];
    const text = S.toCsv(rows);
    ok('the header lists approve first', text.split('\r\n')[0].split(',')[0] === 'approve');
    ok('formula-looking text cells are guarded for Excel', text.includes('\'=HYPERLINK') && text.includes('\'+1 Evil') && text.includes('\'-cmd') && text.includes('\'@b.jpg') === false && text.includes('/p/@b.jpg'));
    ok('…a negative number is left alone', text.includes('-84.25') && !text.includes('\'-84.25'));
    const back = S.parseCsv(text);
    ok('rows survive the round trip', back.length === 2 && back[0].leadName === rows[0].leadName && back[0].leadAddress === rows[0].leadAddress && back[0].file === rows[0].file && back[1].leadName === rows[1].leadName && back[1].leadAddress === '+1 Evil' && back[1].reasons === '-cmd', JSON.stringify(back));
    const excel = '﻿' + text.replace(/\r\n/g, '\n');
    const back2 = S.parseCsv(excel);
    ok('a BOM and bare LF line ends (as editors save it) parse the same', back2.length === 2 && back2[0].approve === '' && back2[1].approve === 'y' && back2[0].leadAddress === rows[0].leadAddress);
    ok('approval reads y / yes / x / 1 / true, any case', ['y', 'YES', 'x', '1', 'True'].every(S.isApproved) && !['', 'n', 'no', '0', ' '].some(S.isApproved));
  });

  // Folder: one job photo under an address folder, one on-site GPS photo, one personal photo.
  const PHOTOS = path.join(TMP, 'Photos Library');
  fs.mkdirSync(path.join(PHOTOS, '1004 Larkspur Dr'), { recursive: true });
  fs.mkdirSync(path.join(PHOTOS, 'Camera Roll', '.hidden'), { recursive: true });
  fs.writeFileSync(path.join(PHOTOS, '1004 Larkspur Dr', 'IMG_0001.jpg'), exifJpeg({ date: '2026:05:13 10:00:00', noGps: true }));
  fs.writeFileSync(path.join(PHOTOS, 'Camera Roll', 'IMG_0002.JPG'), exifJpeg({ date: '2026:05:14 17:30:00' }));
  fs.writeFileSync(path.join(PHOTOS, 'Camera Roll', 'IMG_0003.jpeg'), exifJpeg({ date: '2026:01:02 12:00:00', lat: [40, 0, 0] }));
  fs.writeFileSync(path.join(PHOTOS, 'Camera Roll', 'notes.txt'), 'not a photo');
  fs.writeFileSync(path.join(PHOTOS, 'Camera Roll', '.hidden', 'IMG_9.jpg'), exifJpeg());
  const LEADS_FILE = path.join(TMP, 'leads.json');
  fs.writeFileSync(LEADS_FILE, JSON.stringify([LEAD_A, LEAD_B, LEAD_OLD, LEAD_OTHER]));
  const OUT = path.join(TMP, 'out');

  const logs = [];
  const log = (...a) => logs.push(a.join(' '));
  const noNet = () => { throw new Error('network used'); };
  let dry;
  await guard('5. a dry run writes the review CSV + contact sheet, prints counts only', async () => {
    ok('the photo walk is recursive, skips hidden folders and non-photos', JSON.stringify(S.listPhotoFiles(PHOTOS).map((f) => path.basename(f)).sort()) === JSON.stringify(['IMG_0001.jpg', 'IMG_0002.JPG', 'IMG_0003.jpeg']));
    dry = await S.run(['--photos', PHOTOS, '--leads', LEADS_FILE, '--company', 'co1', '--out', OUT], { log, err: log, fetchImpl: noNet, env: {} });
    ok('exit 0', dry && dry.code === 0, JSON.stringify(dry && dry.summary));
    const csvPath = path.join(OUT, 'photo-match-review.csv');
    const htmlPath = path.join(OUT, 'contact-sheet.html');
    ok('CSV and HTML written to the output folder', fs.existsSync(csvPath) && fs.existsSync(htmlPath));
    const rows = S.parseCsv(fs.readFileSync(csvPath, 'utf8'));
    const byFile = Object.fromEntries(rows.map((r) => [path.basename(r.file), r]));
    ok('the address-folder photo matched lead A by street + date', byFile['IMG_0001.jpg'] && byFile['IMG_0001.jpg'].leadId === 'leadA' && byFile['IMG_0001.jpg'].phase === 'During', JSON.stringify(rows));
    ok('the on-site photo matched lead A by GPS + date, After', byFile['IMG_0002.JPG'] && byFile['IMG_0002.JPG'].leadId === 'leadA' && byFile['IMG_0002.JPG'].phase === 'After');
    ok('the personal photo (elsewhere, off-season) is not in the review', !byFile['IMG_0003.jpeg']);
    ok('approve is blank on every row: Jo decides', rows.every((r) => r.approve === ''));
    ok('the other tenant\'s lead and the 2025 lead are never candidates', rows.every((r) => r.leadId !== 'leadOther' && r.leadId !== 'leadOld'));
    ok('each row carries the file hash the apply step checks', rows.every((r) => /^[0-9a-f]{64}$/.test(r.sha256)));
    const html = fs.readFileSync(htmlPath, 'utf8');
    ok('the contact sheet shows thumbnails by local file URL', html.includes('src="file://') && html.includes('IMG_0001.jpg'));
    ok('the contact sheet has no script and no handler', !/<script/i.test(html) && !/\son[a-z]+\s*=/i.test(html));
    ok('…and loads nothing over the network', !/https?:\/\//i.test(html));
    ok('…and escapes what it prints', !html.includes('O\'Neil') || html.includes('&#39;'));
    const out = logs.join('\n');
    ok('stdout has counts', /photos\s*:\s*3/.test(out) && /matched\s*:\s*2/.test(out), out);
    ok('stdout never names a customer, an address or a file', !/NAMESECRET|Larkspur|Alpha|Bravo|IMG_000/.test(out), out);
    ok('summary counts agree', dry.summary.photos === 3 && dry.summary.matched === 2 && dry.summary.leads === 2);
  });

  await guard('5b. the output folder is never under docs/', async () => {
    const r = await S.run(['--photos', PHOTOS, '--leads', LEADS_FILE, '--company', 'co1', '--out', path.join(ROOT, 'docs', 'tmp-photo-match')], { log() {}, err() {}, env: {} });
    ok('refused with a non-zero exit', r.code !== 0);
    ok('nothing written there', !fs.existsSync(path.join(ROOT, 'docs', 'tmp-photo-match')));
    const r2 = await S.run(['--photos', PHOTOS, '--company', 'co1', '--out', OUT], { log() {}, err() {}, env: {} });
    ok('no leads source (no --leads, no token): refused', r2.code !== 0);
  });

  // ── 6. apply ──
  function fakeStorage() {
    const objects = new Map();
    const calls = [];
    return {
      objects, calls,
      async create(o) {
        calls.push(['create', o.path]);
        if (objects.has(o.path)) { const e = new Error('exists'); e.code = 'already-exists'; throw e; }
        objects.set(o.path, { bytes: o.bytes, contentType: o.contentType, token: o.token });
      },
      async getToken(p) { calls.push(['getToken', p]); return objects.has(p) ? objects.get(p).token : null; },
    };
  }
  function fakeDb(leads, seed) {
    const docs = new Map(Object.entries(seed === undefined ? { 'users/u1': { companyId: 'co1' } } : seed));
    const calls = [];
    return {
      docs, calls,
      photos() { return Array.from(docs.entries()).filter(([k]) => k.startsWith('photos/')); },
      doc(p) {
        return {
          path: p,
          async get() { calls.push(['get', p]); return docs.has(p) ? { exists: true, data: () => docs.get(p) } : { exists: false, data: () => undefined }; },
          async create(d) { calls.push(['create', p]); if (docs.has(p)) { const e = new Error('exists'); e.code = 'already-exists'; throw e; } docs.set(p, d); },
          async set() { calls.push(['set', p]); throw new Error('set must never be used'); },
          async update() { calls.push(['update', p]); throw new Error('update must never be used'); },
        };
      },
      collectionGroup(id) { calls.push(['collectionGroup', id]); throw new Error('a collection-group scan reads every tenant'); },
      collection(id) {
        const make = (filters) => {
          const q = {
            where(f, op, v) { if (op !== '==') throw new Error('== only'); return make(filters.concat([[f, v]])); },
            orderBy() { return q; }, limit() { return q; },
            startAfter() { return { get: async () => ({ empty: true, size: 0, docs: [] }) }; },
            async get() {
              calls.push(['query', id, JSON.stringify(filters)]);
              const all = leads.filter((l) => filters.every(([f, v]) => l[f] === v)).map((l) => ({ id: l.id, ref: { path: id + '/' + l.id }, data: () => l }));
              return { empty: !all.length, size: all.length, docs: all };
            },
          };
          return q;
        };
        return make([]);
      },
    };
  }

  await guard('6. --apply: off by default, create-only, approved rows only', async () => {
    const a0 = S.parseArgs([]);
    ok('no flags: no apply, no yes', a0.apply === null && a0.yes === false);
    const csvPath = path.join(OUT, 'photo-match-review.csv');
    const rows = S.parseCsv(fs.readFileSync(csvPath, 'utf8'));
    // Jo approves the two matches, and adds three rows that must each be refused.
    const heic = path.join(PHOTOS, 'Camera Roll', 'IMG_0004.HEIC');
    fs.writeFileSync(heic, Buffer.from('....ftypheic'));
    rows.forEach((r) => { r.approve = 'y'; });
    const changed = Object.assign({}, rows[0], { sha256: '0'.repeat(64) });
    const heicRow = Object.assign({}, rows[0], { file: heic, sha256: crypto.createHash('sha256').update(fs.readFileSync(heic)).digest('hex') });
    const ghost = Object.assign({}, rows[0], { leadId: 'nope' });
    const tenant = Object.assign({}, rows[0], { leadId: 'leadOther' });
    const unapproved = Object.assign({}, rows[1], { approve: '' });
    const reviewed = path.join(OUT, 'reviewed.csv');
    fs.writeFileSync(reviewed, S.toCsv(rows.concat([changed, heicRow, ghost, tenant, unapproved])));

    const storage = fakeStorage();
    const db = fakeDb([LEAD_A, LEAD_B, LEAD_OTHER]);
    const logs2 = [];
    const deps = { log: (...a) => logs2.push(a.join(' ')), err: (...a) => logs2.push(a.join(' ')), env: { NBD_ACCESS_TOKEN: 'fake-token' }, storage, db, now: () => L(2026, 11, 9, 12) };

    const r1 = await S.run(['--apply', reviewed, '--company', 'co1', '--uid', 'u1'], deps);
    ok('without --yes: exit 0, nothing written', r1.code === 0 && storage.calls.filter((c) => c[0] === 'create').length === 0 && db.calls.filter((c) => c[0] === 'create').length === 0, JSON.stringify(storage.calls) + JSON.stringify(db.calls));
    ok('…a loud warning is printed', /WARNING/.test(logs2.join('\n')) && /Jo/.test(logs2.join('\n')));
    ok('…and the plan counts the two approved, fileable rows', r1.summary && r1.summary.planned === 2, JSON.stringify(r1.summary));

    const r1b = await S.run(['--apply', reviewed, '--leads', LEADS_FILE, '--company', 'co1', '--uid', 'u1', '--yes'], deps);
    ok('--apply refuses a local leads file (apply checks the live leads)', r1b.code !== 0 && storage.objects.size === 0);
    const r1c = await S.run(['--apply', reviewed, '--company', 'co1', '--yes'], deps);
    ok('--apply needs --uid', r1c.code !== 0 && storage.objects.size === 0);

    logs2.length = 0;
    const r2 = await S.run(['--apply', reviewed, '--company', 'co1', '--uid', 'u1', '--yes'], deps);
    ok('with --yes: exit 0', r2.code === 0, JSON.stringify(r2.summary));
    ok('two objects uploaded, two /photos rows created', storage.objects.size === 2 && db.photos().length === 2, JSON.stringify(r2.summary));
    ok('never set() or update()', !db.calls.some((c) => c[0] === 'set' || c[0] === 'update'));
    const sk = r2.summary.skipped || {};
    ok('refusals counted: file changed, HEIC, unknown lead, other tenant (never even read)', sk['file changed since review'] === 1 && sk['heic: export as JPEG first'] === 1 && sk['lead not found'] === 2, JSON.stringify(sk));
    ok('token mode reads only the company\'s leads: no collection-group scan', !db.calls.some((c) => c[0] === 'collectionGroup') && db.calls.some((c) => c[0] === 'query' && c[2].includes('companyId') && c[2].includes('co1')), JSON.stringify(db.calls.filter((c) => c[0] !== 'get')));
    const docs = db.photos();
    const [p0, d0] = docs.find(([, d]) => d.phase === 'During') || [];
    ok('the row is under photos/{id}, id = its own field', p0 && p0 === 'photos/' + d0.id);
    ok('photo-engine.js shape: leadId, userId, companyId, url, storagePath, thumbUrl, tags, phase, createdAt, uploadedAt, reportSections, geoLocation, onSite',
      d0 && d0.leadId === 'leadA' && d0.userId === 'u1' && d0.companyId === 'co1' && Array.isArray(d0.tags) && Array.isArray(d0.reportSections)
      && d0.createdAt === R.SERVER_TS && d0.uploadedAt === R.SERVER_TS && 'geoLocation' in d0 && 'onSite' in d0 && typeof d0.thumbUrl === 'string', JSON.stringify(d0));
    ok('source photo-match', d0.source === 'photo-match' && d0.phaseSource === 'photo-match');
    ok('capturedAt from EXIF (epoch ms)', d0.capturedAt === L(2026, 5, 13, 10) && d0.capturedAtSource === 'exif', String(d0.capturedAt));
    ok('storage path photos/{uid}/{leadId}/…', /^photos\/u1\/leadA\/[A-Za-z0-9_-]+\.jpg$/.test(d0.storagePath), d0.storagePath);
    const obj = storage.objects.get(d0.storagePath);
    ok('the uploaded bytes are the file', obj && Buffer.compare(Buffer.from(obj.bytes), fs.readFileSync(path.join(PHOTOS, '1004 Larkspur Dr', 'IMG_0001.jpg'))) === 0 && obj.contentType === 'image/jpeg');
    ok('url is a download-token URL for that object', d0.url.includes(encodeURIComponent(d0.storagePath)) && d0.url.endsWith('token=' + obj.token));
    const d1 = docs.map((x) => x[1]).find((d) => d.phase === 'After');
    ok('the GPS photo carries geoLocation and is on site', d1 && d1.geoLocation && d1.geoLocation.source === 'exif' && d1.onSite === true);
    ok('stdout names no customer, address or file', !/NAMESECRET|Larkspur|IMG_000/.test(logs2.join('\n')), logs2.join('\n'));

    const before = JSON.stringify(db.photos());
    const r3 = await S.run(['--apply', reviewed, '--company', 'co1', '--uid', 'u1', '--yes'], deps);
    ok('a rerun files nothing twice and overwrites nothing', r3.code === 0 && db.photos().length === 2 && storage.objects.size === 2 && JSON.stringify(db.photos()) === before && (r3.summary.skipped || {})['already filed'] === 2, JSON.stringify(r3.summary));

    // Order: the row exists when the object lands, so functions/image-pipeline.js
    // (finalize → where storagePath ==) stamps urls.{thumb,med,full}.
    const storage2 = fakeStorage();
    const db2 = fakeDb([LEAD_A, LEAD_B]);
    const seq = [];
    const st2 = Object.assign({}, storage2, { async create(o) { seq.push(['upload', o.path, db2.docs.has('photos/' + o.path.split('/').pop().replace(/_original\.\w+$/, ''))]); return storage2.create(o); } });
    const one = path.join(OUT, 'one.csv');
    fs.writeFileSync(one, S.toCsv([rows[0]]));
    await S.run(['--apply', one, '--company', 'co1', '--uid', 'u1', '--yes'], Object.assign({}, deps, { storage: st2, db: db2 }));
    ok('the /photos row exists before its object is uploaded', seq.length === 1 && seq[0][2] === true, JSON.stringify(seq));
    ok('…the row\'s token is the object\'s token', (() => { const [[, dd]] = db2.photos(); return dd.url.endsWith('token=' + storage2.objects.get(dd.storagePath).token); })());

    // A run that died after the row but before the upload: the rerun uploads
    // with the row's own token and writes no second row.
    const [[pp, dd]] = db2.photos();
    const tokenRow = dd.url.split('token=')[1];
    storage2.objects.delete(dd.storagePath);
    const r4 = await S.run(['--apply', one, '--company', 'co1', '--uid', 'u1', '--yes'], Object.assign({}, deps, { storage: storage2, db: db2 }));
    ok('a row without its object is finished by uploading with the row\'s token', r4.code === 0 && db2.photos().length === 1 && storage2.objects.size === 1 && storage2.objects.get(dd.storagePath).token === tokenRow && db2.docs.get(pp) === dd && r4.summary.resumed === 1, JSON.stringify(r4.summary));

    // An object with no row (not made by this script's order): the pipeline has
    // already run and found nothing, so a row now would never get thumbnails.
    const storage3 = fakeStorage();
    const db3 = fakeDb([LEAD_A, LEAD_B]);
    storage3.objects.set(dd.storagePath, { bytes: Buffer.from([1]), contentType: 'image/jpeg', token: 'old' });
    const r5 = await S.run(['--apply', one, '--company', 'co1', '--uid', 'u1', '--yes'], Object.assign({}, deps, { storage: storage3, db: db3 }));
    ok('an orphan object is reported, not adopted', r5.code === 0 && db3.photos().length === 0 && (r5.summary.skipped || {})['storage object exists without a row'] === 1 && storage3.objects.get(dd.storagePath).token === 'old', JSON.stringify(r5.summary));

    // The row a failed upload leaves is reported, and a rerun finishes it.
    const storage4 = fakeStorage();
    const db4 = fakeDb([LEAD_A, LEAD_B]);
    const st4 = Object.assign({}, storage4, { async create() { throw new Error('HTTP 503'); } });
    const r6 = await S.run(['--apply', one, '--company', 'co1', '--uid', 'u1', '--yes'], Object.assign({}, deps, { storage: st4, db: db4 }));
    ok('a failed upload is counted (rerun to finish)', r6.code === 0 && (r6.summary.skipped || {})['upload failed: rerun to finish'] === 1, JSON.stringify(r6.summary));
    const r7 = await S.run(['--apply', one, '--company', 'co1', '--uid', 'u1', '--yes'], Object.assign({}, deps, { storage: storage4, db: db4 }));
    ok('…and the rerun uploads it', r7.summary.resumed === 1 && storage4.objects.size === 1 && db4.photos().length === 1, JSON.stringify(r7.summary));

    // The other-tenant guard in applyRows itself (a lead handed in from anywhere).
    const direct = await S.applyRows([Object.assign({}, rows[0], { leadId: 'leadOther' })], { leads: [LEAD_OTHER], company: 'co1', uid: 'u1', bucket: 'b', write: false }, { readFile: () => null, exifFields: async () => ({}) });
    ok('applyRows refuses another company\'s lead', direct.skipped['lead in another company'] === 1);
  });

  await guard('9. --uid must belong to --company', async () => {
    const reviewed = path.join(OUT, 'reviewed.csv');
    const base = { log() {}, err() {}, env: { NBD_ACCESS_TOKEN: 'fake-token' }, now: () => L(2026, 11, 9, 12) };
    for (const [label, seed] of [
      ['a uid of another company', { 'users/u1': { companyId: 'co2' } }],
      ['a uid with no user doc', {}],
      ['a user doc with no company (and uid != company)', { 'users/u1': { name: 'x' } }],
    ]) {
      const st = fakeStorage(), db = fakeDb([LEAD_A, LEAD_B], seed);
      const r = await S.run(['--apply', reviewed, '--company', 'co1', '--uid', 'u1', '--yes'], Object.assign({}, base, { storage: st, db }));
      ok(label + ': refused, nothing written', r.code === 2 && st.objects.size === 0 && !db.calls.some((c) => c[0] === 'create'), JSON.stringify(r));
      const rPlan = await S.run(['--apply', reviewed, '--company', 'co1', '--uid', 'u1'], Object.assign({}, base, { db: fakeDb([LEAD_A, LEAD_B], seed) }));
      ok(label + ': refused in the plan too', rPlan.code === 2);
    }
    const solo = fakeDb([Object.assign({}, LEAD_A, { companyId: undefined, userId: 'co1' })], { 'users/co1': { name: 'owner' } });
    const rs = await S.run(['--apply', reviewed, '--company', 'co1', '--uid', 'co1'], Object.assign({}, base, { db: solo }));
    ok('a solo owner (uid = company) with no companyId field is accepted', rs.code === 0, JSON.stringify(rs));
    const rep = fakeDb([LEAD_A, LEAD_B], { 'reps/u1': { companyId: 'co1' } });
    const rr = await S.run(['--apply', reviewed, '--company', 'co1', '--uid', 'u1'], Object.assign({}, base, { db: rep }));
    ok('a rep doc of the company is accepted (functions/handlers/photo.js order)', rr.code === 0, JSON.stringify(rr));
  });

  await guard('10. no EXIF date: capturedAt is not the apply day', async () => {
    const bare = path.join(PHOTOS, 'Camera Roll', 'IMG_NODATE.jpg');
    fs.writeFileSync(bare, Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]));
    const row = { approve: 'y', phase: 'After', leadId: 'leadA', file: bare, sha256: crypto.createHash('sha256').update(fs.readFileSync(bare)).digest('hex') };
    const csv = path.join(OUT, 'nodate.csv');
    fs.writeFileSync(csv, S.toCsv([row]));
    const st = fakeStorage(), db = fakeDb([LEAD_A]);
    const r = await S.run(['--apply', csv, '--company', 'co1', '--uid', 'u1', '--yes'], { log() {}, err() {}, env: { NBD_ACCESS_TOKEN: 'x' }, storage: st, db, now: () => L(2026, 11, 9, 12) });
    const d = Array.from(db.docs.values()).find((x) => x.leadId === 'leadA');
    ok('filed', r.code === 0 && d, JSON.stringify(r.summary));
    ok('capturedAt null, capturedAtSource unknown (readers fall back to createdAt)', d && d.capturedAt === null && d.capturedAtSource === 'unknown' && !('deviceCapturedAt' in d), JSON.stringify(d));
    fs.rmSync(bare);
  });

  await guard('11. a backfilled job ends at completedAt, not a later click', async () => {
    // Installed 05-09, marked done quietly on 07-01 (completedAt 05-10), moved to final_payment 07-02.
    const lead = { id: 'bf', companyId: 'co1', address: '12 Birch Ln', completedBackfill: true, completedAt: iso(L(2026, 5, 10, 17)), createdAt: iso(L(2026, 4, 1)),
      stage: 'final_payment',
      stageHistory: [
        { to: 'install_in_progress', timestamp: iso(L(2026, 5, 9, 8)) },
        { to: 'install_complete', timestamp: iso(L(2026, 7, 1, 9)), backfill: true, completedOn: '2026-05-10' },
        { to: 'final_payment', timestamp: iso(L(2026, 7, 2, 9)) },
      ] };
    const w = S.leadWindows(lead);
    ok('end = completedAt', w.end === L(2026, 5, 10, 17), JSON.stringify(w));
    ok('a June photo is After', S.phaseFor(L(2026, 6, 1, 12), w) === 'After');
    const s = S.scorePhotoLead({ relPath: 'x/IMG.jpg', takenMs: L(2026, 6, 1, 12), gps: null }, lead, w);
    ok('…and not "date in install window"', !s.reasons.includes('date in install window'), JSON.stringify(s.reasons));
    const flagOnly = Object.assign({}, lead, { stageHistory: [lead.stageHistory[0], lead.stageHistory[2]] });
    ok('the lead flag alone (history trimmed) also prefers completedAt', S.leadWindows(flagOnly).end === L(2026, 5, 10, 17));
    const eventOnly = Object.assign({}, lead, { completedBackfill: undefined });
    ok('a backfill event alone also prefers completedAt', S.leadWindows(eventOnly).end === L(2026, 5, 10, 17));
    const normal = Object.assign({}, lead, { completedBackfill: undefined, stageHistory: [lead.stageHistory[0], { to: 'install_complete', timestamp: iso(L(2026, 5, 10, 16)) }], completedAt: iso(L(2026, 8, 1)) });
    ok('a normal job still ends at its first after-stage move', S.leadWindows(normal).end === L(2026, 5, 10, 16));
  });

  await guard('12. a directional prefix is not the street word', async () => {
    const lead = { id: 'dir', companyId: 'co1', address: '1004 N Main St, Lebanon, OH', createdAt: iso(L(2026, 5, 1)), installCompletedAt: iso(L(2026, 5, 13, 16)) };
    const w = S.leadWindows(lead);
    const hit = (rel) => S.scorePhotoLead({ relPath: rel, takenMs: null, gps: null }, lead, w).kinds.includes('street');
    ok('"1004 N Elm" is not 1004 N Main', !hit('1004 N Elm/IMG.jpg'));
    ok('"1004 North Main" is 1004 N Main', hit('1004 North Main/IMG.jpg'));
    ok('"1004 N Main" is 1004 N Main', hit('1004 N Main/IMG.jpg'));
    ok('"1004 Main St" (no direction) is 1004 N Main', hit('1004 Main St/IMG.jpg'));
    ok('"1004 S Main" is not 1004 N Main', !hit('1004 S Main/IMG.jpg'));
    const north = { id: 'ns', companyId: 'co1', address: '100 North St', createdAt: iso(L(2026, 5, 1)) };
    const hitN = (rel) => S.scorePhotoLead({ relPath: rel, takenMs: null, gps: null }, north, S.leadWindows(north)).kinds.includes('street');
    ok('a street named North still matches itself', hitN('100 North St/IMG.jpg'));
    ok('…and not 100 N Elm', !hitN('100 N Elm/IMG.jpg'));
  });

  await guard('13. the output folder is never inside the repo', async () => {
    const inRepo = path.join(ROOT, 'tmp-photo-match-test-out');
    const r = await S.run(['--photos', PHOTOS, '--leads', LEADS_FILE, '--company', 'co1', '--out', inRepo], { log() {}, err() {}, env: {} });
    ok('refused with a non-zero exit', r.code === 2);
    ok('nothing written there', !fs.existsSync(inRepo));
  });

  await guard('14. the REST client: a filtered collection query', async () => {
    const R2 = require(path.join(ROOT, 'scripts', '_firestore-rest.js'));
    const seen = [];
    const fetchQ = async (url, init) => { seen.push({ url, body: JSON.parse(init.body) }); return { status: 200, text: async () => JSON.stringify([{ document: { name: 'projects/p/databases/(default)/documents/leads/a1', fields: { companyId: { stringValue: 'co1' } } } }]) }; };
    const db = R2.restFirestore({ projectId: 'p', token: 't', fetchImpl: fetchQ });
    const snap = await db.collection('leads').where('companyId', '==', 'co1').orderBy('__name__').limit(300).get();
    const sq = seen[0].body.structuredQuery;
    ok('top-level collection only (allDescendants false)', sq.from[0].collectionId === 'leads' && sq.from[0].allDescendants === false);
    ok('an equality filter on the field', sq.where.fieldFilter.field.fieldPath === 'companyId' && sq.where.fieldFilter.op === 'EQUAL' && sq.where.fieldFilter.value.stringValue === 'co1');
    ok('docs decoded', snap.size === 1 && snap.docs[0].id === 'a1' && snap.docs[0].data().companyId === 'co1');
    await db.collection('leads').where('userId', '==', 'u1').orderBy('__name__').limit(2).startAfter(snap.docs[0]).get();
    ok('paging by name continues after the last doc', seen[1].body.structuredQuery.startAt.values[0].referenceValue.endsWith('/leads/a1'));
  });


  await guard('7. the REST Storage client is create-only', async () => {
    const seen = [];
    const fetch412 = async (url, init) => { seen.push({ url, init }); return { status: 412, text: async () => '{}' }; };
    const st = S.makeRestStorage({ bucket: 'b.example', token: 'tok-SECRET', fetchImpl: fetch412 });
    let err = null;
    try { await st.create({ path: 'photos/u/l/x.jpg', bytes: Buffer.from([1, 2]), contentType: 'image/jpeg', token: 'dl' }); } catch (e) { err = e; }
    ok('412 → already-exists', err && err.code === 'already-exists');
    ok('ifGenerationMatch=0 on the upload', /[?&]ifGenerationMatch=0(&|$)/.test(seen[0].url) && seen[0].init.method === 'POST');
    ok('the access token travels in the header only', seen[0].init.headers.Authorization === 'Bearer tok-SECRET' && !seen[0].url.includes('tok-SECRET') && !(err && String(err.message).includes('tok-SECRET')));
    const okFetch = async (url, init) => { seen.push({ url, init }); return { status: 200, text: async () => JSON.stringify({ metadata: { firebaseStorageDownloadTokens: 't1,t2' } }) }; };
    const st2 = S.makeRestStorage({ bucket: 'b.example', token: 'tok', fetchImpl: okFetch });
    await st2.create({ path: 'photos/u/l/y.jpg', bytes: Buffer.from([1]), contentType: 'image/jpeg', token: 'dl2' });
    const body = Buffer.from(seen[seen.length - 1].init.body).toString('latin1');
    ok('the download token goes in the object metadata', body.includes('"firebaseStorageDownloadTokens":"dl2"') && body.includes('"name":"photos/u/l/y.jpg"'));
    ok('getToken reads the first token', (await st2.getToken('photos/u/l/y.jpg')) === 't1');
  });

  await guard('8. phase stage lists match photo-engine.js', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', 'photo-engine.js'), 'utf8');
    const list = (name) => JSON.parse(src.match(new RegExp('const ' + name + ' = (\\[[^\\]]*\\])'))[1].replace(/'/g, '"').replace(/\s+/g, ' '));
    ok('During list', JSON.stringify(S.PHASE_DURING) === JSON.stringify(list('_PHASE_DURING')));
    ok('After list', JSON.stringify(S.PHASE_AFTER) === JSON.stringify(list('_PHASE_AFTER')));
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
