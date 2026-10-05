#!/usr/bin/env node
/**
 * tests/deal-packet-2026-10-04.test.js — "Full packet" or "Paperwork only"
 * when Jo sends a deal to the homeowner (Jo, 2026-10-04).
 *
 *   A. deal-packet-logic.js (server rules): default full; paperwork carries
 *      no photo IDs; a photo rides the link only when it is the link owner's,
 *      on the deal's lead, stored under photos/<owner>/; the link check
 *      (expired / revoked / accepted / removed deal); the served section.
 *   B. deal-packet.js (client): default full; the 3–6 inspection photos
 *      (estimate picks, then inspection shots, then newest; own photos only);
 *      the choice is REMEMBERED per user on userSettings/{uid}.dealPacket and
 *      read back in a fresh session; another user gets the default.
 *   C. close-board.js: the deal doc gets packet: 'full' | 'paperwork'; the
 *      generated page — full: photo MARKER + scope + reviews/trust, never a
 *      photo URL; paperwork: none of them.
 *   D. getDealRoom (driven, Firebase stubbed): a full packet's page shows the
 *      photos at /deal/<token>/photo/<n> only — a foreign photo is dropped —
 *      and the payload holds no 'alt=media' / 'token=' Storage URL;
 *      paperwork shows no photos section even if the page carried a marker.
 *   E. getDealPhoto (driven, REAL sharp): EXIF / GPS stripped; dies with the
 *      link (expired, revoked, accepted → 410); paperwork / foreign / out of
 *      range → 404; no-store.
 *   F. estimate-v2-ui.js "Send to homeowner": default full packet with the
 *      lead's photos (minus the one Jo deselected) + scope names; Paperwork
 *      only sends no photo IDs; the choice is remembered.
 *
 * Run: node tests/deal-packet-2026-10-04.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + String(detail).slice(0, 300) : '')); }
}
async function section(title, fn) {
  console.log(title);
  try { await fn(); } catch (e) { ok(title + ' — ran', false, e && (e.stack || e.message)); }
}
// The rule the task names: no Storage download URL in anything the homeowner gets.
const STORAGE_TOKEN_RE = /alt=media|token=/;

const UID = 'u_owner_1';
const LEAD = 'lead_abc123';
const TOKEN = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const tokUrl = (p) => 'https://firebasestorage.googleapis.com/v0/b/nobigdeal-pro.appspot.com/o/' + encodeURIComponent(p) + '?alt=media&token=11111111-2222-3333-4444-555555555555';

(async () => {
  // ═══ A ═══════════════════════════════════════════════════════════════
  await section('A. deal-packet-logic.js — the server rules', async () => {
    const DP = require(path.join(ROOT, 'functions/deal-packet-logic.js'));
    ok('default packet is full (absent / junk)', DP.normalizePacket(undefined) === 'full' && DP.normalizePacket('x') === 'full' && DP.normalizePacket('full') === 'full');
    ok('paperwork stays paperwork', DP.normalizePacket('paperwork') === 'paperwork');
    ok('a paperwork deal carries no photo IDs even if the doc lists some',
      DP.packetPhotoIds({ packet: 'paperwork', packetPhotoIds: ['photo_1a', 'photo_2b'] }).length === 0);
    ok('a full deal: valid IDs, de-duplicated, at most 6',
      JSON.stringify(DP.packetPhotoIds({ packet: 'full', packetPhotoIds: ['p_000001', 'p_000001', '../x', 'p_000002', 'p_000003', 'p_000004', 'p_000005', 'p_000006', 'p_000007'] }))
        === JSON.stringify(['p_000001', 'p_000002', 'p_000003', 'p_000004', 'p_000005', 'p_000006']));
    const ctx = { ownerUid: UID, leadId: LEAD };
    const good = { userId: UID, leadId: LEAD, storagePath: 'photos/' + UID + '/' + LEAD + '/1_roof.jpg' };
    ok('own photo on the deal\'s lead → servable', DP.checkPacketPhoto(good, ctx).ok === true);
    ok('another user\'s photo → refused', DP.checkPacketPhoto(Object.assign({}, good, { userId: 'u_other' }), ctx).reason === 'owner');
    ok('a photo on another lead → refused', DP.checkPacketPhoto(Object.assign({}, good, { leadId: 'lead_other' }), ctx).reason === 'lead');
    ok('a deleted photo → refused', DP.checkPacketPhoto(Object.assign({}, good, { deleted: true }), ctx).reason === 'deleted');
    ok('a path outside photos/<owner>/ → refused', DP.checkPacketPhoto(Object.assign({}, good, { storagePath: 'photos/u_other/x.jpg' }), ctx).reason === 'path'
      && DP.checkPacketPhoto(Object.assign({}, good, { storagePath: 'photos/' + UID + '/../u_other/x.jpg' }), ctx).reason === 'path');
    const legacy = { userId: UID, leadId: LEAD, url: tokUrl('photos/' + UID + '/old.jpg') };
    ok('legacy doc (URL only): the object PATH is read from the URL', DP.checkPacketPhoto(legacy, ctx).path === 'photos/' + UID + '/old.jpg');
    ok('variant path = image-pipeline\'s _variants/<base>_full.webp', DP.variantFullPath('photos/u/l/1_roof.jpg') === 'photos/u/l/_variants/1_roof_full.webp');
    const now = Date.parse('2026-10-04T12:00:00Z');
    const live = { status: 'pending', expiresAt: { toMillis: () => now + 1e6 }, ownerUid: UID };
    ok('live link → no refusal', DP.linkRefusal(live, { status: 'sent' }, now) === null);
    ok('expired link → 410', DP.linkRefusal(Object.assign({}, live, { expiresAt: { toMillis: () => now - 1 } }), { status: 'sent' }, now).status === 410);
    ok('revoked link (Fresh link) → 410', DP.linkRefusal(Object.assign({}, live, { revokedAt: { seconds: 1 } }), { status: 'sent' }, now).status === 410);
    ok('accepted deal → 410', DP.linkRefusal(live, { status: 'accepted' }, now).status === 410);
    ok('removed deal → 410; no token → 404', DP.linkRefusal(live, null, now).status === 410 && DP.linkRefusal(null, null, now).status === 404);
    const page = '<div>tiers</div>' + DP.PHOTO_MARKER + '<div>scope</div>';
    const full = DP.injectPhotos(page, { token: TOKEN, packet: 'full', items: [{ i: 0 }, { i: 2, caption: 'North <slope>' }] });
    ok('full: the marker becomes the photos section, served via the deal link', /src="\/deal\/ABCDEFGHJKLMNPQRSTUVWXYZ\/photo\/0"/.test(full) && /src="\/deal\/ABCDEFGHJKLMNPQRSTUVWXYZ\/photo\/2"/.test(full) && full.indexOf(DP.PHOTO_MARKER) === -1, full);
    ok('captions are escaped', /North &lt;slope&gt;/.test(full));
    const paper = DP.injectPhotos(page, { token: TOKEN, packet: 'paperwork', items: [{ i: 0 }] });
    ok('paperwork: no photos section, marker removed', !/class="deal-photos/.test(paper) && paper === '<div>tiers</div><div>scope</div>', paper);
    ok('full with nothing servable: no empty section', !/deal-photos/.test(DP.injectPhotos(page, { token: TOKEN, packet: 'full', items: [] })));
    ok('containsStorageUrl flags a download-token URL', DP.containsStorageUrl(tokUrl('photos/a.jpg')) && !DP.containsStorageUrl(full));
  });

  // ═══ B ═══════════════════════════════════════════════════════════════
  function loadClientDP(store, uid, ls) {
    const win = { _user: uid ? { uid } : null, db: {}, localStorage: ls || memLS() };
    win.window = win;
    win.doc = (_db, col, id) => col + '/' + id;
    win.getDoc = async (p) => ({ exists: () => store.has(p), data: () => store.get(p) });
    win.setDoc = async (p, data, opts) => { store.set(p, Object.assign({}, (opts && opts.merge && store.get(p)) || {}, data)); };
    const c = { window: win, console, Date, Math, JSON, Set, Map, Promise };
    vm.createContext(c);
    vm.runInContext(read('docs/pro/js/deal-packet.js'), c, { filename: 'deal-packet.js' });
    return win;
  }
  function memLS() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }

  await section('B. deal-packet.js — default, photo pick, remembered per user', async () => {
    const store = new Map();
    const w = loadClientDP(store, UID);
    const P = w.NBDDealPacket;
    ok('default choice is full', P.current() === 'full');
    const photos = [
      { id: 'ph_new01', userId: UID, _ms: 900 },
      { id: 'ph_dmg01', userId: UID, category: 'Damage', _ms: 100 },
      { id: 'ph_est01', userId: UID, _ms: 50 },
      { id: 'ph_bef01', userId: UID, phase: 'Before', _ms: 200 },
      { id: 'ph_mate1', userId: 'u_teammate', category: 'Damage', _ms: 999 },
      { id: 'ph_old01', userId: UID, _ms: 10 }, { id: 'ph_old02', userId: UID, _ms: 20 },
      { id: 'ph_old03', userId: UID, _ms: 30 }, { id: 'ph_del01', userId: UID, deleted: true, _ms: 5000 },
    ];
    const ids = P.candidates(photos, { uid: UID, estimatePhotoIds: ['ph_est01'] }).map((p) => p.id);
    ok('candidates: estimate pick first, then inspection shots, then newest; max 6', JSON.stringify(ids) === JSON.stringify(['ph_est01', 'ph_bef01', 'ph_dmg01', 'ph_new01', 'ph_old03', 'ph_old02']), JSON.stringify(ids));
    ok('candidates: never a teammate\'s or a deleted photo', ids.indexOf('ph_mate1') === -1 && ids.indexOf('ph_del01') === -1);
    ok('selectedIds: Jo\'s deselection is left out', P.selectedIds(photos, { uid: UID, excluded: ['ph_dmg01'] }).indexOf('ph_dmg01') === -1);
    ok('dealFields(paperwork) drops photo IDs', JSON.stringify(P.dealFields('paperwork', ['ph_dmg01'])) === JSON.stringify({ packet: 'paperwork', packetPhotoIds: [] }));
    const landed = await P.remember('paperwork');
    ok('remember: written to userSettings/{uid}.dealPacket', landed === true && store.get('userSettings/' + UID).dealPacket === 'paperwork');
    ok('remember: current() answers it at once', P.current() === 'paperwork');
    // A fresh session (new page, localStorage purged by sign-out) reads it back.
    const w2 = loadClientDP(store, UID, memLS());
    ok('fresh session before the read: default', w2.NBDDealPacket.current() === 'full');
    ok('fresh session after load(): the remembered paperwork', (await w2.NBDDealPacket.load()) === 'paperwork' && w2.NBDDealPacket.current() === 'paperwork');
    const w3 = loadClientDP(store, 'u_someone_else', memLS());
    ok('another user: their own (default full) choice', (await w3.NBDDealPacket.load()) === 'full');
  });

  // ═══ C ═══════════════════════════════════════════════════════════════
  function loadCB() {
    const win = { addEventListener() {}, _user: null };
    win.window = win;
    const doc = { getElementById: () => null, addEventListener() {}, querySelector: () => null };
    win.document = doc;
    const c = { window: win, document: doc, console: { log() {}, warn() {}, error() {} }, localStorage: memLS(), setTimeout, clearTimeout, navigator: {}, Date, Math, JSON };
    vm.createContext(c);
    vm.runInContext(read('docs/pro/js/estimate-config.js'), c);
    vm.runInContext(read('docs/assets/js/financing-band.js'), c);
    vm.runInContext(read('docs/pro/js/deal-packet.js'), c);
    win._brand = () => ({ legalName: 'No Big Deal Home Solutions', contact: { phone: '(859) 420-7382' } });
    vm.runInContext(read('docs/pro/js/close-board.js'), c);
    return { CB: win.CloseBoard, win };
  }
  const tierOf = (p) => ({ price: p, description: '', lineItems: [] });
  const baseDeal = (extra) => Object.assign({
    id: 'dr_test01', customerName: 'Pat', address: '1 Test St, Milford, OH 45150', repName: 'Joe', repEmail: 'jd@example.test', repPhone: '(859) 420-7382',
    tiers: { good: tierOf(11000), better: tierOf(13000), best: tierOf(15000) },
    // Things a careless renderer could leak: the Storage URL of the page itself.
    shareUrl: tokUrl('deal_rooms/u/dr_test01.html'),
  }, extra || {});

  await section('C. close-board.js — the deal doc and the generated page', async () => {
    const { CB } = loadCB();
    const d1 = CB.createFromEstimate({ id: 'est_1', prices: { good: 11000 } }, { id: LEAD, firstName: 'Pat' });
    ok('createFromEstimate with no choice → packet: full', d1.packet === 'full' && Array.isArray(d1.packetPhotoIds));
    const d2 = CB.createFromEstimate({ id: 'est_2', prices: { good: 11000 }, packet: 'full', packetPhotoIds: ['ph_dmg01', 'ph_bef01'], scopeSummary: ['Tear off', 'Ice & water'] }, { id: LEAD, firstName: 'Pat' });
    ok('full: photo IDs (not URLs) + scope names on the deal', d2.packet === 'full' && JSON.stringify(d2.packetPhotoIds) === '["ph_dmg01","ph_bef01"]' && d2.scopeSummary.length === 2);
    const d3 = CB.createFromEstimate({ id: 'est_2', prices: { good: 11000 }, packet: 'paperwork', packetPhotoIds: ['ph_dmg01'] }, { id: LEAD, firstName: 'Pat' });
    ok('re-send as paperwork updates the SAME deal: packet paperwork, no photo IDs', d3.id === d2.id && d3.packet === 'paperwork' && d3.packetPhotoIds.length === 0);

    const full = CB.generatePageHTML(baseDeal({ packet: 'full', packetPhotoIds: ['ph_dmg01'], scopeSummary: ['Tear off 1 layer', 'Ice & water shield'] }));
    ok('full page: body data-packet="full"', /<body data-packet="full">/.test(full));
    ok('full page: the photos marker (filled server-side through the link)', full.indexOf('<!--nbd:deal-photos-->') !== -1);
    ok('full page: the scope summary', /What's Included/.test(full) && /Ice &amp; water shield/.test(full));
    ok('full page: reviews / trust', /Why Homeowners Choose Us/.test(full) && /href="https:\/\/nobigdealwithjoedeal\.com\/review"/.test(full));
    ok('full page: no Storage URL anywhere (no alt=media / token=)', !STORAGE_TOKEN_RE.test(full));
    ok('full page: tiers + per-tier warranty + signature still there', /data-deal-tier="better"/.test(full) && /tier-warranty/.test(full) && /id="sigCanvas"/.test(full));
    const paper = CB.generatePageHTML(baseDeal({ packet: 'paperwork', packetPhotoIds: ['ph_dmg01'], scopeSummary: ['Tear off'] }));
    ok('paperwork page: body data-packet="paperwork"', /<body data-packet="paperwork">/.test(paper));
    ok('paperwork page: no photos marker, no scope, no reviews', paper.indexOf('nbd:deal-photos') === -1 && !/What's Included/.test(paper) && !/Why Homeowners Choose Us/.test(paper));
    ok('paperwork page: tiers, terms (deposit / warranty) and the signature', /data-deal-tier="good"/.test(paper) && /tier-warranty/.test(paper) && /id="sigCanvas"/.test(paper) && /ACCEPT &amp; SCHEDULE|ACCEPT & SCHEDULE/.test(paper));
    const legacy = CB.generatePageHTML(baseDeal({}));
    ok('a deal saved before packets renders as full (the default)', /<body data-packet="full">/.test(legacy));
  });

  // ═══ D + E: deal-acceptance.js with Firebase stubbed ═══════════════════
  function makeDb(docs) {
    const store = new Map(Object.entries(docs));
    return {
      store,
      doc: (p) => ({
        get: async () => ({ exists: store.has(p), data: () => store.get(p) }),
        update: async (patch) => { if (!store.has(p)) throw new Error('nf'); store.set(p, Object.assign({}, store.get(p), patch)); },
        set: async (v) => store.set(p, v),
      }),
      collection: () => ({ add: async () => ({}) }),
      runTransaction: async () => null,
    };
  }
  let CUR = { db: null, files: new Map() };
  const storageStub = { bucket: () => ({ file: (p) => ({ download: async () => { if (!CUR.files.has(p)) throw new Error('No such object: ' + p); return [CUR.files.get(p)]; } }) }) };
  const STUBS = {
    'firebase-functions/v2/https': { onCall: (o, h) => h, onRequest: (o, h) => Object.assign(h, { __opts: o }), HttpsError: class extends Error {} },
    'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {} } },
    'firebase-admin/firestore': { FieldValue: { serverTimestamp: () => 'ts', increment: (n) => n }, Timestamp: { fromMillis: (m) => ({ toMillis: () => m }) }, getFirestore: () => CUR.db },
    'firebase-admin/storage': { getStorage: () => storageStub },
    './integrations/upstash-ratelimit': { httpRateLimit: async () => true },
    './shared': { callableRateLimit: async () => {}, assertNotViewer() {} },
    './deal-install-date': { fillLeadInstallDate: async () => null },
    './job-spine': { spineAfterDealAccept: async () => null },
    './estimate-view-alert': { recordEstimateView: async () => null },
  };
  function loadDA() {
    const file = path.join(ROOT, 'functions/deal-acceptance.js');
    delete require.cache[file];
    const orig = Module._load;
    Module._load = function (request, parent, isMain) {
      if (parent && parent.filename === file && Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
      return orig.apply(this, arguments);
    };
    try { return require(file); } finally { Module._load = orig; }
  }
  function fakeRes() {
    const r = { code: 0, headers: {}, body: null, ended: false };
    r.status = (c) => { r.code = c; return r; };
    r.set = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
    r.send = (b) => { r.body = b; r.ended = true; return r; };
    r.end = () => { r.ended = true; return r; };
    r.json = (b) => { r.body = b; r.ended = true; return r; };
    return r;
  }
  // A link-preview UA ('' counts as a bot) so getDealRoom stamps nothing.
  const req = (p) => ({ path: p, method: 'GET', get: () => '' });
  const sharp = require(path.join(ROOT, 'functions/node_modules/sharp'));
  // A real camera-style JPEG carrying GPS + device EXIF.
  const gpsJpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#7a3' } })
    .jpeg()
    .withExif({ IFD0: { Make: 'LEAKYCAM', Model: 'Phone 99' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '39/1 5/1 30/1', GPSLongitudeRef: 'W', GPSLongitude: '84/1 15/1 0/1' } })
    .toBuffer();

  function world(over) {
    const o = over || {};
    const now = Date.now();
    const ph = (id, extra) => ['photos/' + id, Object.assign({ userId: UID, leadId: LEAD, storagePath: 'photos/' + UID + '/' + LEAD + '/' + id + '.jpg', url: tokUrl('photos/' + UID + '/' + LEAD + '/' + id + '.jpg') }, extra || {})];
    const docs = Object.fromEntries([
      ['deal_accept_tokens/' + TOKEN, Object.assign({ dealId: 'dr_test01', ownerUid: UID, status: 'pending', htmlPath: 'deal_rooms/' + UID + '/dr_test01.html', expiresAt: { toMillis: () => now + 864e5 } }, o.tok || {})],
      ['deal_rooms/dr_test01', Object.assign({ userId: UID, leadId: LEAD, status: 'sent', packet: 'full', packetPhotoIds: ['ph_a00001', 'ph_b00002', 'ph_c00003'] }, o.room || {})],
      ph('ph_a00001'),
      ph('ph_b00002', { userId: 'u_stranger', storagePath: 'photos/u_stranger/x/ph_b00002.jpg' }), // planted foreign photo
      ph('ph_c00003', { homeownerCaption: 'Hail hits, north slope' }),
    ]);
    CUR = { db: makeDb(docs), files: new Map() };
    CUR.files.set('photos/' + UID + '/' + LEAD + '/ph_a00001.jpg', gpsJpeg);
    CUR.files.set('photos/' + UID + '/' + LEAD + '/ph_c00003.jpg', gpsJpeg);
    CUR.files.set('photos/u_stranger/x/ph_b00002.jpg', gpsJpeg);
    return CUR;
  }

  await section('D. getDealRoom — photos only for a full packet, only via the deal link', async () => {
    const DA = loadDA();
    const { CB } = loadCB();
    // The page the rep's client uploads, generated by the real close-board.js.
    const fullHtml = CB.generatePageHTML(baseDeal({ packet: 'full', scopeSummary: ['Tear off'] }));
    world();
    CUR.files.set('deal_rooms/' + UID + '/dr_test01.html', Buffer.from(fullHtml));
    let res = fakeRes();
    await DA.getDealRoom(req('/deal/' + TOKEN), res);
    const page = String(res.body || '');
    ok('full: 200', res.code === 200, res.code + ' ' + page.slice(0, 200));
    ok('full: photos section rendered', /class="deal-photos"/.test(page));
    const srcs = (page.match(/<img [^>]*src="([^"]+)"/g) || []).map((t) => t.replace(/.*src="([^"]+)".*/, '$1'));
    ok('full: every photo is /deal/<token>/photo/<n> — own photos 0 and 2, the planted foreign one dropped',
      JSON.stringify(srcs) === JSON.stringify(['/deal/' + TOKEN + '/photo/0', '/deal/' + TOKEN + '/photo/2']), JSON.stringify(srcs));
    ok('full: the payload has no Storage URL (no alt=media, no token=)', !STORAGE_TOKEN_RE.test(page), (page.match(/.{40}(alt=media|token=).{40}/) || [''])[0]);
    ok('full: the homeowner caption shows (escaped)', /Hail hits, north slope/.test(page));

    // Paperwork, even if the uploaded page still carries a marker (stale page).
    world({ room: { packet: 'paperwork' } });
    CUR.files.set('deal_rooms/' + UID + '/dr_test01.html', Buffer.from(fullHtml));
    res = fakeRes();
    await DA.getDealRoom(req('/deal/' + TOKEN), res);
    const paper = String(res.body || '');
    ok('paperwork: 200, no photos section, no <img>', res.code === 200 && !/class="deal-photos/.test(paper) && !/\/photo\/\d/.test(paper) && !/<img /.test(paper), paper.slice(0, 120));
    ok('control: the uploaded page DID carry the marker', fullHtml.indexOf('<!--nbd:deal-photos-->') !== -1);
    ok('paperwork: no Storage URL either', !STORAGE_TOKEN_RE.test(paper));
  });

  await section('E. getDealPhoto — EXIF/GPS stripped, expires with the link', async () => {
    const DA = loadDA();
    ok('getDealPhoto is exported (hosting rewrite target)', typeof DA.getDealPhoto === 'function');
    const rw = JSON.parse(read('firebase.json')).hosting.rewrites;
    const iPhoto = rw.findIndex((r) => r.source === '/deal/*/photo/*');
    const iDeal = rw.findIndex((r) => r.source === '/deal/**');
    ok('rewrite /deal/*/photo/* → getDealPhoto, BEFORE /deal/**', iPhoto >= 0 && rw[iPhoto].function.functionId === 'getDealPhoto' && iPhoto < iDeal);

    world();
    let res = fakeRes();
    await DA.getDealPhoto(req('/deal/' + TOKEN + '/photo/0'), res);
    ok('own photo: 200 image/jpeg', res.code === 200 && res.headers['content-type'] === 'image/jpeg', res.code);
    ok('no-store (never cached past the link)', /no-store/.test(res.headers['cache-control'] || '') && /private/.test(res.headers['cache-control'] || ''));
    const meta = res.body ? await sharp(res.body).metadata() : {};
    ok('the served bytes are a real image', meta.format === 'jpeg' && meta.width === 64);
    ok('EXIF stripped (no exif block)', res.body && !meta.exif, meta.exif && meta.exif.length);
    ok('GPS + device strings gone from the bytes', res.body && res.body.indexOf('LEAKYCAM') === -1 && res.body.indexOf('GPS') === -1);
    ok('control: the stored original DID carry them', gpsJpeg.indexOf('LEAKYCAM') !== -1 && !!(await sharp(gpsJpeg).metadata()).exif);

    res = fakeRes(); await DA.getDealPhoto(req('/deal/' + TOKEN + '/photo/1'), res);
    ok('planted foreign photo (another user\'s) → 404', res.code === 404 && !res.body);
    res = fakeRes(); await DA.getDealPhoto(req('/deal/' + TOKEN + '/photo/5'), res);
    ok('index past the deal\'s photos → 404', res.code === 404);
    res = fakeRes(); await DA.getDealPhoto(req('/deal/NOTATOKEN0000/photo/0'), res);
    ok('unknown token → 404', res.code === 404);

    world({ tok: { expiresAt: { toMillis: () => Date.now() - 1000 } } });
    res = fakeRes(); await DA.getDealPhoto(req('/deal/' + TOKEN + '/photo/0'), res);
    ok('expired deal link → 410, no bytes', res.code === 410 && !res.body);
    world({ tok: { revokedAt: { seconds: 1 } } });
    res = fakeRes(); await DA.getDealPhoto(req('/deal/' + TOKEN + '/photo/0'), res);
    ok('revoked link (Fresh link minted) → 410', res.code === 410);
    world({ room: { status: 'accepted' } });
    res = fakeRes(); await DA.getDealPhoto(req('/deal/' + TOKEN + '/photo/0'), res);
    ok('accepted deal → 410', res.code === 410);
    world({ room: { packet: 'paperwork' } });
    res = fakeRes(); await DA.getDealPhoto(req('/deal/' + TOKEN + '/photo/0'), res);
    ok('paperwork packet → 404 (no photos on that link)', res.code === 404);
  });

  // ═══ F ═══════════════════════════════════════════════════════════════
  function fakeEl(id) {
    const cls = new Set();
    const attrs = {};
    return {
      id, textContent: '', innerHTML: '', hidden: false, disabled: false, style: {}, value: '',
      classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
        toggle: (c, on) => { const want = on === undefined ? !cls.has(c) : !!on; if (want) cls.add(c); else cls.delete(c); return want; } },
      setAttribute: (k, v) => { attrs[k] = String(v); }, getAttribute: (k) => attrs[k], _attrs: attrs,
    };
  }
  function loadV2(store, uid) {
    const ids = ['v2sendHoBtn', 'v2shareStatus', 'v2shareBox', 'v2saveBtn', 'v2saveStatus', 'estV2Modal', 'v2packetFull', 'v2packetPaper', 'v2packetHint', 'v2packetPhotos', 'v2signBtn', 'v2signStatus', 'v2kyNote', 'v2kyContractBtn'];
    const els = {}; ids.forEach((i) => { els[i] = fakeEl(i); });
    const doc = { getElementById: (i) => els[i] || null, querySelector: () => null, querySelectorAll: () => [],
      createElement: () => Object.assign(fakeEl(''), { appendChild() {}, addEventListener() {} }), addEventListener() {}, body: { appendChild() {} }, head: { appendChild() {} } };
    const calls = [];
    const win = {};
    win.window = win;
    win._user = { uid };
    win.localStorage = memLS();
    win.db = {};
    win.doc = (_db, col, id) => col + '/' + id;
    win.getDoc = async (p) => ({ exists: () => store.has(p), data: () => store.get(p) });
    win.setDoc = async (p, data) => { store.set(p, Object.assign({}, store.get(p) || {}, data)); };
    win.NBDJurisdiction = require(path.join(ROOT, 'docs/pro/js/ky-insurance-law.js'));
    win.NBD_XACT_CATALOG = { find: (code) => ({ code, name: code, unit: 'SQ' }) };
    win.EstimateLogic = { resolveEstimate: () => ({ lines: [{ code: 'RFG', name: 'Architectural shingles', quantity: 20, unit: 'SQ', lineTotal: 9000 }, { code: 'IWS', name: 'Ice & water shield', quantity: 3, unit: 'SQ', lineTotal: 600 }], subtotal: 9600, tax: 0, total: 9600 }), buildContext: (x) => x, MEASUREMENT_VARS: [] };
    win.EstimateBuilderV2 = { loadSettings: () => ({ countyTax: {} }), calculatePerSq: () => ({}),
      calculateAllTiers: () => ({ economy: { total: 9000 }, good: { total: 11000 }, better: { total: 13000 }, best: { total: 15000 }, beyond: { total: 17000 } }) };
    win._saveEstimate = async () => { calls.push(['save']); win._editingEstimateId = null; return 'est_1'; };
    win.CloseBoard = {
      createFromEstimate: (est, lead) => { calls.push(['deal', est]); return { id: 'dr_1' }; },
      getAcceptLink: async () => 'https://example.test/deal/' + TOKEN,
      markShared: () => {},
    };
    win.showToast = () => {};
    const c = { window: win, document: doc, navigator: { share: async () => {} }, console: { log() {}, warn() {}, error() {} },
      Date, Math, JSON, Set, Map, Promise, setTimeout: () => 0, clearTimeout() {}, localStorage: win.localStorage };
    vm.createContext(c);
    vm.runInContext(read('docs/pro/js/deal-packet.js'), c, { filename: 'deal-packet.js' });
    vm.runInContext(read('docs/pro/js/estimate-v2-ui.js'), c, { filename: 'estimate-v2-ui.js' });
    const T = win.EstimateV2UI._test;
    const st = T.getState();
    st.scope = [{ code: 'RFG' }];
    st.measurements.rawSqft = 2000;
    st.mode = 'per-sq'; st.jobMode = 'cash'; st.tier = 'better';
    st.customer = { name: 'Pat Homeowner', address: '1 Test St, Milford, OH 45150', phone: '(513) 555-0101', email: '', leadId: LEAD };
    st._leadPhotos = { _leadId: LEAD, list: [
      { id: 'ph_dmg01', url: tokUrl('photos/u/a.jpg'), userId: uid, category: 'Damage', _ms: 300 },
      { id: 'ph_bef01', url: tokUrl('photos/u/b.jpg'), userId: uid, phase: 'Before', _ms: 200 },
      { id: 'ph_new01', url: tokUrl('photos/u/c.jpg'), userId: uid, _ms: 900 },
    ] };
    return { T, st, win, els, calls };
  }

  await section('F. Send to homeowner — packet choice, photos, remembered', async () => {
    const store = new Map();
    const V = loadV2(store, UID);
    ok('default choice is Full packet', V.T.packetChoice() === 'full');
    V.T.renderPacket();
    ok('the picker shows the lead\'s 3 photos, Full packet pressed', (V.els.v2packetPhotos.innerHTML.match(/data-action="toggle-packet-photo"/g) || []).length === 3
      && V.els.v2packetFull.classList.contains('active') && !V.els.v2packetPaper.classList.contains('active'));
    V.T.togglePacketPhoto('ph_new01'); // Jo deselects one
    await V.T.sendToHomeowner();
    const d1 = (V.calls.find((x) => x[0] === 'deal') || [])[1] || {};
    ok('full send: packet "full" on the deal', d1.packet === 'full', JSON.stringify(d1));
    ok('full send: the inspection photos by ID, minus the deselected one', JSON.stringify(d1.packetPhotoIds) === JSON.stringify(['ph_dmg01', 'ph_bef01']), JSON.stringify(d1.packetPhotoIds));
    ok('full send: scope NAMES (no prices)', JSON.stringify(d1.scopeSummary) === JSON.stringify(['Architectural shingles', 'Ice & water shield']));
    ok('full send: nothing the deal gets holds a Storage URL', !STORAGE_TOKEN_RE.test(JSON.stringify(d1)));

    V.T.setPacket('paperwork');
    ok('Paperwork only pressed; picker hidden', V.els.v2packetPaper.classList.contains('active') && V.els.v2packetPhotos.hidden === true);
    V.calls.length = 0;
    await V.T.sendToHomeowner();
    const d2 = (V.calls.find((x) => x[0] === 'deal') || [])[1] || {};
    ok('paperwork send: packet "paperwork", no photo IDs', d2.packet === 'paperwork' && Array.isArray(d2.packetPhotoIds) && d2.packetPhotoIds.length === 0, JSON.stringify(d2));
    await new Promise((r) => setImmediate(r));
    ok('the choice is remembered on userSettings/{uid}', (store.get('userSettings/' + UID) || {}).dealPacket === 'paperwork');

    // Next session (fresh page, localStorage gone): it opens on Paperwork only.
    const V2 = loadV2(store, UID);
    await V2.win.NBDDealPacket.load();
    ok('next session: Paperwork only is pre-selected', V2.T.packetChoice() === 'paperwork');
  });

  console.log('\n──────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})();
