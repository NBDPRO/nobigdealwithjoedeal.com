#!/usr/bin/env node
/**
 * tests/review-ask-photo-2026-10-16.test.js — the customer's own before/after
 * photo in the automatic review ask email (functions/review-ask-photo.js).
 *
 *   A. the pick: a tagged before + after pair > a single After > none
 *   B. never another lead's or another tenant's photo (pure filter AND the
 *      full read on a fake Firestore, including a doc pointing into someone
 *      else's Storage folder)
 *   C. EXIF / GPS stripped from what is sent (real sharp, a fixture JPEG that
 *      carries GPS), inline cid: images, no URL, nothing made public
 *   D. the email without a photo is byte-for-byte the 2026-10-15 one (pinned
 *      hash), and the photo wording: no incentive, no gating, no rating
 *   E. the sweep end to end: flag off = no photo (and no Storage read), flag
 *      on = the pair inline, a broken photo still sends the plain ask
 *   F. wiring (env, registry)
 *
 * Needs functions/ deps (sharp). Never sends anything: the sender is a fake.
 * Run: node tests/review-ask-photo-2026-10-16.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const fnRequire = createRequire(path.join(FN, 'package.json'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const RA = require(path.join(FN, 'review-ask-auto-logic.js'));
const RP = require(path.join(FN, 'review-ask-photo.js'));
const AUTO = require(path.join(FN, 'review-ask-auto.js'))._test;

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

const DAY = 86400000;
const NOW = Date.now();
const NBD = RA.NBD_OWNER_UID;
const ago = (d) => NOW - d * DAY;

// ── fake Firestore (review-ask-auto test's shape) ─────────────────────────
function makeDb(seed) {
  const clone = (d) => JSON.parse(JSON.stringify(d));
  const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, clone(v)]));
  const val = (v, cur) => { if (v === '__TS__') return NOW; if (v && v.__inc) return (Number(cur) || 0) + v.__inc; return v; };
  const apply = (cur, patch) => { const d = Object.assign({}, cur); for (const k of Object.keys(patch)) d[k] = val(patch[k], d[k]); return d; };
  const reads = [];
  const ref = (p) => ({
    path: p, id: p.split('/').pop(),
    collection: (c) => col(p + '/' + c),
    async get() { reads.push(p); const d = store.get(p); return { exists: d !== undefined, id: p.split('/').pop(), data: () => (d === undefined ? undefined : clone(d)) }; },
    async update(patch) { if (!store.has(p)) throw new Error('NOT_FOUND ' + p); store.set(p, apply(store.get(p), patch)); },
    async set(data, o) { store.set(p, o && o.merge ? apply(store.get(p) || {}, data) : apply({}, data)); },
  });
  const query = (c, filters, lim, group) => ({
    where: (f, op, v) => query(c, filters.concat([[f, op, v]]), lim, group),
    orderBy: () => query(c, filters, lim, group),
    limit: (n) => query(c, filters, n, group),
    async get() {
      reads.push('query:' + c);
      const docs = [];
      for (const [k, v] of store) {
        const parts = k.split('/');
        if (group) { if (parts.length < 2 || parts[parts.length - 2] !== c) continue; }
        else if (parts.length !== c.split('/').length + 1 || !k.startsWith(c + '/')) continue;
        if (filters.every(([f, op, x]) => (op === 'in' ? x.includes(v[f]) : op === '>=' ? v[f] >= x : v[f] === x))) docs.push(Object.assign(ref(k), { data: () => clone(v), ref: ref(k) }));
      }
      const out = docs.slice(0, lim || docs.length);
      return { docs: out, empty: out.length === 0, size: out.length };
    },
  });
  let auto = 0;
  const col = (c) => Object.assign({
    doc: (id) => ref(c + '/' + (id || ('auto' + (++auto)))),
    async add(d) { const id = 'auto' + (++auto); store.set(c + '/' + id, apply({}, d)); return ref(c + '/' + id); },
  }, query(c, [], 0));
  return {
    store, reads, collection: col, doc: (p) => ref(p), collectionGroup: (n) => query(n, [], 0, true),
    async runTransaction(fn) {
      const pending = [];
      const tx = { get: (r) => r.get(), set: (r, d) => pending.push(() => r.set(d)), update: (r, p) => pending.push(() => r.update(p)) };
      const out = await fn(tx);
      for (const f of pending) await f();
      return out;
    },
  };
}
const FV = { serverTimestamp: () => '__TS__', increment: (n) => ({ __inc: n }) };
const quiet = { info() {}, warn() {}, error() {} };
const POSTAL = '123 Test St, Florence, KY 41042';
const ON = { REVIEW_ASK_AUTO_EMAIL_ENABLED: 'true' };
const ON_PHOTO = { REVIEW_ASK_AUTO_EMAIL_ENABLED: 'true', REVIEW_ASK_EMAIL_PHOTO_ENABLED: 'true' };

const leadOf = (o) => Object.assign({
  userId: NBD, companyId: NBD, firstName: 'Pat', lastName: 'Homeowner', email: 'pat@example.com', phone: '(859) 555-0142',
  stage: 'final_payment', stageRole: 'won', stageStartedAt: ago(8), state: 'KY',
}, o || {});
const paidInvOf = (leadId, receivedAt) => ({
  leadId, companyId: NBD, status: 'paid', total: 12000, amountPaid: 12000, balanceDue: 0, paidAt: receivedAt,
  payments: [{ amount: 12000, at: receivedAt, recordedAt: receivedAt, method: 'check' }],
});
const baseSeed = () => ({
  ['users/' + NBD]: { email: 'jd@nobigdealwithjoedeal.com' },
  ['companyProfile/' + NBD]: { brand: { contact: { mailingAddress: POSTAL } } },
});
const photo = (id, o) => Object.assign({
  id, leadId: 'L1', userId: NBD, companyId: NBD, storagePath: 'photos/' + NBD + '/L1/' + id + '.jpg', createdAt: ago(30),
}, o || {});
function fakeResend() {
  const sent = [];
  return { sent, emails: { send: async (m) => { sent.push(JSON.parse(JSON.stringify(m))); return { data: { id: 're_' + sent.length }, error: null }; } } };
}
const deps = (o) => Object.assign({ env: ON, FieldValue: FV, logger: quiet, nowMs: NOW }, o || {});
const hash = (c) => crypto.createHash('sha256').update(c.subject + '\n' + c.html + '\n' + c.text).digest('hex');

(async () => {
  const sharp = fnRequire('sharp');
  const GPS_EXIF = {
    IFD0: { Make: 'ZZ_QA Camera', Model: 'Review QA' },
    IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '39/1 6/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '84/1 30/1 0/1' },
  };
  const jpegWithGps = (w, h, rgb) => sharp({ create: { width: w, height: h, channels: 3, background: rgb } }).jpeg().withExif(GPS_EXIF).toBuffer();
  const BEFORE_JPG = await jpegWithGps(3000, 2000, { r: 120, g: 90, b: 60 });
  const AFTER_JPG = await jpegWithGps(3000, 2000, { r: 60, g: 70, b: 80 });

  // ═══ A ═══
  console.log('\nA. the pick: pair > single > none');
  {
    const b1 = photo('b1', { phase: 'Before', createdAt: ago(40) });
    const b2 = photo('b2', { phase: 'Before', createdAt: ago(35) });
    const a1 = photo('a1', { phase: 'After', createdAt: ago(12) });
    const a2 = photo('a2', { phase: 'After', createdAt: ago(10) });
    const d1 = photo('d1', { phase: 'During', createdAt: ago(20), tags: ['after'] });
    const p = RP.pickPhotos([a1, b2, d1, b1, a2]);
    ok('Before + After on the lead → a pair: the earliest Before, the latest After', p && p.kind === 'pair' && p.before.id === 'b1' && p.after.id === 'a2', JSON.stringify(p && { k: p.kind, b: p.before && p.before.id, a: p.after && p.after.id }));
    const s = RP.pickPhotos([a1, a2, d1]);
    ok('After only → the latest After alone', s && s.kind === 'single' && s.after.id === 'a2');
    ok('Before only → no photo (a damage shot is not "your roof")', RP.pickPhotos([b1, b2]) === null);
    ok('no phase at all / During only → no photo', RP.pickPhotos([photo('x'), d1]) === null && RP.pickPhotos([]) === null && RP.pickPhotos(null) === null);
    ok('a phase field wins over a tag (During tagged "after" is not an After)', RP.phaseOf(d1) === null);
    ok('tags count when no phase is set: before / after / completed_work',
      RP.phaseOf(photo('t1', { tags: ['before', 'ridge'] })) === 'before' && RP.phaseOf(photo('t2', { tags: ['after'] })) === 'after' && RP.phaseOf(photo('t3', { tags: ['completed_work'] })) === 'after');
    const lb = photo('lb', { phase: 'Before', location: 'Back slope', createdAt: ago(50) });
    const la = photo('la', { phase: 'After', location: 'back slope, ridge', createdAt: ago(11) });
    const lp = RP.pickPhotos([b1, lb, a2, la]);
    ok('a Before and After of the same location are paired before the chronological fallback', lp.kind === 'pair' && lp.before.id === 'lb' && lp.after.id === 'la', JSON.stringify({ b: lp.before.id, a: lp.after.id }));
    ok('capturedAt beats createdAt for the order', RP.pickPhotos([photo('c1', { phase: 'After', createdAt: ago(1), capturedAt: ago(30) }), photo('c2', { phase: 'After', createdAt: ago(5) })]).after.id === 'c2');
  }

  // ═══ B ═══
  console.log('\nB. never another lead\'s or another tenant\'s photo');
  {
    const lead = leadOf();
    const mine = photo('mine', { phase: 'After' });
    const all = [
      mine,
      photo('otherLead', { phase: 'After', leadId: 'L2', storagePath: 'photos/' + NBD + '/L2/x.jpg' }),
      photo('otherTenant', { phase: 'After', userId: 'u-other', companyId: 'co-other', storagePath: 'photos/u-other/L1/x.jpg' }),
      photo('foreignFolder', { phase: 'After', storagePath: 'photos/u-other/L1/y.jpg' }),
      photo('deleted', { phase: 'After', deleted: true }),
      photo('otherJob', { phase: 'After', jobId: 'job-old' }),
      photo('video', { phase: 'After', storagePath: 'photos/' + NBD + '/L1/clip.mp4' }),
      photo('traversal', { phase: 'After', storagePath: 'photos/' + NBD + '/../u-other/z.jpg' }),
      photo('noPath', { phase: 'After', storagePath: '' }),
    ];
    const e = RP.eligiblePhotos(lead, 'L1', 'job-new', all).map((p) => p.id);
    ok('only this lead\'s, this tenant\'s, live, image, this-job photo survives the filter', JSON.stringify(e) === JSON.stringify(['mine', 'foreignFolder']), JSON.stringify(e));
    ok('no lead id → nothing', RP.eligiblePhotos(lead, '', null, all).length === 0);
    ok('a photo stamped with another job of the lead is left out; one with no job stays', !e.includes('otherJob') && RP.eligiblePhotos(lead, 'L1', null, all).some((p) => p.id === 'otherJob'));
    const shared = RP.eligiblePhotos(lead, 'L1', null, [mine, photo('s', { phase: 'After', sharedWithHomeowner: true })]).map((p) => p.id);
    ok('once the rep shared ANY photo with the homeowner, only shared photos are used', JSON.stringify(shared) === '["s"]');
    const annotated = photo('ann', { phase: 'After', isAnnotated: true, storagePath: 'photos/' + NBD + '/L1/photo_ann.jpg', originalStoragePath: 'photos/' + NBD + '/L1/orig.jpg' });
    ok('an annotated photo uses its pristine original', RP.objectPathOf(annotated) === 'photos/' + NBD + '/L1/orig.jpg');

    // The full read: the doc pointing into another user's folder is dropped by
    // the object-owner check (that user is not in the photo's company).
    const seed = Object.assign(baseSeed(), { 'users/u-other': { companyId: 'co-other' } });
    all.forEach((p) => { seed['photos/' + p.id] = Object.assign({}, p, { id: undefined }); });
    const db = makeDb(seed);
    const loaded = [];
    const loader = async (p) => { loaded.push(p); return AFTER_JPG; };
    const r = await RP.photoForEmail(db, Object.assign({ id: 'L1', jobId: 'job-new' }, lead), { loader, logger: quiet });
    ok('photoForEmail reads ONLY this lead\'s own photo object', r && r.kind === 'single' && r.photoIds[0] === 'mine' && loaded.length === 1 && loaded[0] === 'photos/' + NBD + '/L1/mine.jpg', JSON.stringify({ r: r && r.photoIds, loaded }));
    const onlyForeign = makeDb(Object.assign(baseSeed(), { 'users/u-other': { companyId: 'co-other' },
      'photos/f1': { leadId: 'L1', userId: NBD, companyId: NBD, phase: 'After', storagePath: 'photos/u-other/L1/y.jpg' },
      'photos/f2': { leadId: 'L1', userId: 'u-other', companyId: 'co-other', phase: 'After', storagePath: 'photos/u-other/L1/x.jpg' },
      'photos/f3': { leadId: 'L2', userId: NBD, companyId: NBD, phase: 'After', storagePath: 'photos/' + NBD + '/L2/x.jpg' } }));
    const loaded2 = [];
    const r2 = await RP.photoForEmail(onlyForeign, Object.assign({ id: 'L1' }, lead), { loader: async (p) => { loaded2.push(p); return AFTER_JPG; }, logger: quiet });
    ok('a lead whose only photos are another lead\'s / tenant\'s / folder\'s → no photo, nothing read from Storage', r2 === null && loaded2.length === 0, JSON.stringify(loaded2));
    const teammate = makeDb(Object.assign(baseSeed(), { 'users/rep2': { companyId: NBD },
      'photos/t1': { leadId: 'L1', userId: NBD, companyId: NBD, phase: 'After', storagePath: 'photos/rep2/L1/t.jpg' } }));
    const r3 = await RP.photoForEmail(teammate, Object.assign({ id: 'L1' }, lead), { loader: async () => AFTER_JPG, logger: quiet });
    ok('a teammate\'s folder in the same company is allowed (offboarded rep\'s photos)', r3 && r3.kind === 'single');
  }

  // ═══ C ═══
  console.log('\nC. EXIF / GPS stripped from what is sent');
  {
    const meta = await sharp(BEFORE_JPG).metadata();
    ok('fixture: the source JPEGs carry EXIF with the GPS IFD (positive control)', !!meta.exif && meta.exif.includes(Buffer.from('ZZ_QA Camera')) && BEFORE_JPG.includes(Buffer.from('ZZ_QA Camera')));
    const db = makeDb(Object.assign(baseSeed(), {
      'photos/b': { leadId: 'L1', userId: NBD, companyId: NBD, phase: 'Before', storagePath: 'photos/' + NBD + '/L1/b.jpg', createdAt: ago(40) },
      'photos/a': { leadId: 'L1', userId: NBD, companyId: NBD, phase: 'After', storagePath: 'photos/' + NBD + '/L1/a.jpg', createdAt: ago(10) },
    }));
    const files = { ['photos/' + NBD + '/L1/b.jpg']: BEFORE_JPG, ['photos/' + NBD + '/L1/a.jpg']: AFTER_JPG };
    const r = await RP.photoForEmail(db, Object.assign({ id: 'L1' }, leadOf()), { loader: async (p) => files[p], logger: quiet });
    ok('a pair comes back as two inline JPEG attachments', r && r.kind === 'pair' && r.attachments.length === 2 && r.attachments.every((a) => a.contentType === 'image/jpeg' && /^nbd-review-(before|after)$/.test(a.contentId)));
    for (const a of (r ? r.attachments : [])) {
      const buf = Buffer.from(a.content, 'base64');
      const m = await sharp(buf).metadata();
      ok(a.filename + ': no EXIF, no GPS, no XMP / IPTC in the sent image', !m.exif && !m.xmp && !m.iptc && !buf.includes(Buffer.from('ZZ_QA Camera')) && !buf.includes(Buffer.from('GPS')), 'exif ' + (m.exif ? m.exif.length : 0));
      ok(a.filename + ': resized for email (long edge ' + RP.PAIR_EDGE + ')', m.format === 'jpeg' && Math.max(m.width, m.height) === RP.PAIR_EDGE, m.width + 'x' + m.height);
    }
    const src = read('functions/review-ask-photo.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    ok('no public object, no signed or download-token URL: the bytes go inline', !/makePublic|getSignedUrl|firebaseStorageDownloadTokens|getDownloadURL|https?:\/\//.test(src));
    ok('every image goes through the shared EXIF-stripping re-encode', /require\('\.\/photo-reencode'\)/.test(src) && /reencodePhoto\(raw, 'jpeg'/.test(src));
    const bad = await RP.photoForEmail(db, Object.assign({ id: 'L1' }, leadOf()), { loader: async () => Buffer.from('not an image'), logger: quiet });
    ok('bytes that are not an image → no photo (never the raw bytes)', bad === null);
    const halfBad = await RP.photoForEmail(db, Object.assign({ id: 'L1' }, leadOf()), { loader: async (p) => (/b\.jpg$/.test(p) ? Buffer.from('x') : files[p]), logger: quiet });
    ok('a Before that cannot be read → the After alone', halfBad && halfBad.kind === 'single' && halfBad.photoIds[0] === 'a');
    const slow = await RP.photoForEmail(db, Object.assign({ id: 'L1' }, leadOf()), { loader: () => new Promise(() => {}), logger: quiet, timeoutMs: 50 });
    ok('a Storage read that hangs → no photo after the timeout', slow === null);
    const thrown = await RP.photoForEmail({ collection: () => { throw new Error('boom'); } }, { id: 'L1' }, { logger: quiet });
    ok('a Firestore error → no photo, never a throw', thrown === null);
  }

  // ═══ D ═══
  console.log('\nD. the email without a photo is unchanged; the photo wording');
  {
    // sha256 of subject + html + text from main at 2026-10-16 (#2474's email).
    const PINNED = '069d144242a34931be9268b3bcae0757a0a4a7b75c4a347e12f89db922bc521f';
    const PINNED_NONAME = 'e914fd4ec40979985f418796b7d7a85d10c1d9132765f89a61a8426205b61e10';
    const plain = RA.emailContent({ firstName: 'Pat', userId: NBD }, RA.NBD_REVIEW_URL);
    ok('no photo → byte-for-byte the 2026-10-15 email (pinned hash)', hash(plain) === PINNED && hash(RA.emailContent({}, RA.NBD_REVIEW_URL)) === PINNED_NONAME, hash(plain));
    ok('photo null / undefined / junk → the same email', [null, undefined, {}, { kind: 'pair', images: [] }, { kind: 'single', images: [{ cid: 'bad cid"><script>' }] }]
      .every((p) => hash(RA.emailContent({ firstName: 'Pat', userId: NBD }, RA.NBD_REVIEW_URL, p)) === PINNED));
    const pair = RA.emailContent(leadOf(), RA.NBD_REVIEW_URL, RP.contentFor('pair', 'roof'));
    ok('pair: "Here\'s your roof, before and after" above the unchanged ask', /<p>Here&#39;s your roof, before and after:<\/p>/.test(pair.html)
      && pair.html.indexOf('before and after') < pair.html.indexOf('Thank you for trusting') && /^Hi Pat,\n\nHere's your roof, before and after/.test(pair.text));
    ok('pair: both images are cid: references with Before / After labels and alt text', /src="cid:nbd-review-before" alt="Your roof before the work"/.test(pair.html) && /src="cid:nbd-review-after" alt="Your roof after the work"/.test(pair.html) && />Before<\/div>/.test(pair.html) && />After<\/div>/.test(pair.html));
    const plainBody = plain.html.replace('<p>Hi Pat,</p>', '');
    ok('the ask, link, reply line and sign-off are exactly the old ones', pair.html.replace(/<p>Hi Pat,<\/p>/, '').replace(/<p>Here&#39;s your roof[\s\S]*?<\/table>/, '') === plainBody);
    ok('the subject is unchanged', pair.subject === plain.subject);
    const single = RA.emailContent(leadOf(), RA.NBD_REVIEW_URL, RP.contentFor('single', 'roof'));
    ok('single: "Here\'s your finished roof" and one cid: image', /Here&#39;s your finished roof:/.test(single.html) && (single.html.match(/cid:/g) || []).length === 1);
    ok('a siding / gutter job says "project", a roof or unknown job says "roof"', RP.subjectWord({}, { title: 'Siding replacement' }) === 'project' && RP.subjectWord({ jobType: 'Gutters' }) === 'project'
      && RP.subjectWord({}, { title: 'Roof + gutters' }) === 'roof' && RP.subjectWord({}, null) === 'roof');
    const all = (pair.html + pair.text + single.html + single.text).toLowerCase();
    ok('the photo lines add no incentive, no gating, no rating prompt', !/\b(gift card|discount|coupon|reward|raffle|drawing|enter to win|free|if you (were|are) (happy|satisfied)|5[- ]star|five[- ]star|rate us|how many stars|only if)\b|\$\d/.test(all));
    ok('the photos come before the one ask; still exactly one review link button', (pair.html.match(/Leave a Google review/g) || []).length === 1);
  }

  // ═══ E ═══
  console.log('\nE. the sweep end to end (fake sender, nothing leaves)');
  {
    const seed = () => Object.assign(baseSeed(), {
      'leads/L1': leadOf(), 'invoices/i1': paidInvOf('L1', ago(8)),
      'photos/b': { leadId: 'L1', userId: NBD, companyId: NBD, phase: 'Before', storagePath: 'photos/' + NBD + '/L1/b.jpg', createdAt: ago(40) },
      'photos/a': { leadId: 'L1', userId: NBD, companyId: NBD, phase: 'After', storagePath: 'photos/' + NBD + '/L1/a.jpg', createdAt: ago(10) },
      'photos/x': { leadId: 'L9', userId: NBD, companyId: NBD, phase: 'After', storagePath: 'photos/' + NBD + '/L9/x.jpg', createdAt: ago(9) },
    });
    const files = { ['photos/' + NBD + '/L1/b.jpg']: BEFORE_JPG, ['photos/' + NBD + '/L1/a.jpg']: AFTER_JPG, ['photos/' + NBD + '/L9/x.jpg']: AFTER_JPG };

    // Flag off: the 2026-10-15 email, and the photo code never runs.
    const loadedOff = [];
    const dbOff = makeDb(seed());
    const resOff = fakeResend();
    await AUTO.runForUser(dbOff, NBD, deps({ resend: resOff, env: ON, photoLoader: async (p) => { loadedOff.push(p); return files[p]; } }));
    const mOff = resOff.sent[0] || {};
    const noPhotoDb = makeDb(Object.assign(baseSeed(), { 'leads/L1': leadOf(), 'invoices/i1': paidInvOf('L1', ago(8)) }));
    const resNo = fakeResend();
    await AUTO.runForUser(noPhotoDb, NBD, deps({ resend: resNo, env: ON_PHOTO }));
    const mNo = resNo.sent[0] || {};
    ok('flag off → one email, no attachments, no photo line, no photo or Storage read', resOff.sent.length === 1 && !('attachments' in mOff) && !/cid:|before and after/.test(mOff.html || '')
      && loadedOff.length === 0 && !dbOff.reads.includes('query:photos'));
    ok('flag "TRUE" / "1" is still off', !RP.photoFlagOn({ REVIEW_ASK_EMAIL_PHOTO_ENABLED: 'TRUE' }) && !RP.photoFlagOn({ REVIEW_ASK_EMAIL_PHOTO_ENABLED: '1' }) && !RP.photoFlagOn({}) && RP.photoFlagOn(ON_PHOTO));
    const strip = (m) => (m.html || '').replace(/\/unsubscribe\/[A-Za-z0-9_-]+/g, '/unsubscribe/T') + '|' + (m.text || '').replace(/\/unsubscribe\/[A-Za-z0-9_-]+/g, '/unsubscribe/T');
    ok('flag on but no photos on the lead → the same email as flag off, no attachments', resNo.sent.length === 1 && !('attachments' in mNo) && strip(mNo) === strip(mOff));

    // Flag on, photos on the lead.
    const dbOn = makeDb(seed());
    const resOn = fakeResend();
    const loadedOn = [];
    const out = await AUTO.runForUser(dbOn, NBD, deps({ resend: resOn, env: ON_PHOTO, photoLoader: async (p) => { loadedOn.push(p); return files[p]; } }));
    const m = resOn.sent[0] || {};
    ok('flag on → ONE email with the pair inline', resOn.sent.length === 1 && out.asked === 1 && Array.isArray(m.attachments) && m.attachments.length === 2, JSON.stringify(out.results));
    ok('the html references both attachments by cid', (m.attachments || []).every((a) => (m.html || '').indexOf('cid:' + a.contentId) > 0));
    ok('only this lead\'s photo objects were read (never L9\'s)', loadedOn.length === 2 && loadedOn.every((p) => /\/L1\//.test(p)), JSON.stringify(loadedOn));
    ok('the CAN-SPAM footer, unsubscribe headers and campaign header are untouched', (m.html || '').indexOf(POSTAL) > 0 && /\/unsubscribe\/[A-Za-z0-9_-]{43}/.test(m.text || '')
      && (m.headers || {})['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click' && (m.headers || {})['X-NBD-Campaign'] === 'review-ask-auto-v1');
    for (const a of (m.attachments || [])) {
      const buf = Buffer.from(a.content, 'base64');
      const md = await sharp(buf).metadata();
      ok('sent ' + a.filename + ': no EXIF / GPS', !md.exif && !buf.includes(Buffer.from('ZZ_QA Camera')));
    }
    ok('still one ask per job: the next day sends nothing', (await AUTO.runForUser(dbOn, NBD, deps({ resend: resOn, env: ON_PHOTO, photoLoader: async (p) => files[p] }))).asked === 0 && resOn.sent.length === 1);

    // A broken photo never blocks the ask.
    const dbBad = makeDb(seed());
    const resBad = fakeResend();
    await AUTO.runForUser(dbBad, NBD, deps({ resend: resBad, env: ON_PHOTO, photoLoader: async () => { throw new Error('storage down'); } }));
    ok('Storage down → the plain ask is still sent, without attachments', resBad.sent.length === 1 && !('attachments' in resBad.sent[0]) && strip(resBad.sent[0]) === strip(mOff));
    // Unsubscribed: the photo is never even looked up.
    const Suppression = require(path.join(FN, 'email-suppression.js'));
    const dbU = makeDb(Object.assign(seed(), { ['email_suppressions/' + Suppression.suppressionId(NBD, 'pat@example.com')]: { companyId: NBD, email: 'pat@example.com' } }));
    const loadedU = [];
    await AUTO.runForUser(dbU, NBD, deps({ resend: fakeResend(), env: ON_PHOTO, photoLoader: async (p) => { loadedU.push(p); return files[p]; } }));
    ok('an unsubscribed customer → no photo read at all', loadedU.length === 0 && !dbU.reads.includes('query:photos'));
  }

  // ═══ F ═══
  console.log('\nF. wiring');
  {
    const env = read('functions/.env.nobigdeal-pro');
    ok('.env.nobigdeal-pro: REVIEW_ASK_EMAIL_PHOTO_ENABLED=true', /^REVIEW_ASK_EMAIL_PHOTO_ENABLED=true\s*$/m.test(env));
    const REG = require(path.join(FN, 'flags-registry.js'));
    const row = REG.FLAGS.find((f) => f.name === 'REVIEW_ASK_EMAIL_PHOTO_ENABLED');
    ok('registered as an "enabled" flag read by review-ask-photo.js', row && row.kind === 'enabled' && row.file === 'review-ask-photo.js' && row.group === 'Customer follow-ups');
    const s = read('functions/review-ask-auto.js').replace(/\/\*[\s\S]*?\*\//g, '');
    ok('the photo is looked up after the unsubscribe / postal-address gate and before the claim', s.indexOf('gate.blocked') < s.indexOf('RP.photoForEmail(') && s.indexOf('RP.photoForEmail(') < s.indexOf('claim(db, entry.id'));
    ok('attachments are added only when there is a photo', /if \(photo\) msg\.attachments = photo\.attachments;/.test(s));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) console.log('FAILED:\n  - ' + fails.join('\n  - '));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
