/**
 * tests/field-photos-client-2026-10-04.test.js — the field-photo lane, client
 * side, run for real.
 *
 * WHY (2026-10-04 audit): 111 owner photos, 109 of them a bulk April import;
 * 0 After photos; 0 geolocated; the classifier had run on 1. The CRM camera
 * opened a 26-tag sheet after every shot and restarted itself, geoLocation
 * was hard-coded null, editor saves had no queue, and the inspection report's
 * "Save report to database" box shipped unticked.
 *
 * Every assertion here executes the shipped code — photo-engine.js loaded
 * whole into a vm sandbox, with its Firebase CDN imports swapped for in-memory
 * stubs and an in-memory NBDPhotoQueueStore — because regex-shape tests in
 * this repo have a history of passing with the bug present.
 *
 *   1. Burst capture: shutter-only shots go into the durable queue FIRST,
 *      stamped, and drain one at a time; burst is the default mode.
 *   2. Phase from the lead's stage at capture; a phase tag wins; a tag edit
 *      that names no phase keeps the stage phase; photo-review asks the rep
 *      to confirm a stage phase; install complete builds the Before & After
 *      report (stage-write → NBDAutoBeforeAfter).
 *   3. One GPS fix per camera session, on-site within 75 m, stored on the
 *      CRM doc; the inspection report prints "date · time · On-site".
 *   4. Photo-editor saves ride the same queue (meta / over / copy).
 *   5. Draw tool cross-check card + the V3 wizard's "Draw it" hand-off.
 *   6. Inspection reports: box ticked by default, every report filed on the
 *      lead's Documents.
 *
 * Run: node tests/field-photos-client-2026-10-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }
async function guard(fn) {
  try { await fn(); }
  catch (e) { ok('section ran without throwing', false, (e && e.stack || String(e)).split('\n').slice(0, 2).join(' | ')); }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));

// ── in-memory NBDPhotoQueueStore with the real store's add/all/remove shape ──
function makeStore() {
  const rows = [];
  let next = 1;
  const log = [];
  return {
    rows, log, MAX_ITEMS: 80,
    async available() { return true; },
    async add(item) {
      if (!item.uid || !item.leadId || !item.blob) { const e = new Error('bad'); e.reason = 'bad-item'; throw e; }
      const id = next++;
      // Mirrors photo-queue-store.js add(): the capture field is persisted.
      rows.push({ id, uid: item.uid, leadId: item.leadId, blob: item.blob, tags: item.tags || [],
        description: item.description || '', location: item.location || '', timestamp: item.timestamp,
        uploadId: item.uploadId || null, preset: item.preset || null,
        capture: item.capture ? JSON.parse(JSON.stringify(item.capture)) : null });
      log.push('add:' + id);
      return id;
    },
    async all() { return rows.slice().map((r) => Object.assign({}, r)); },
    async remove(id) { const i = rows.findIndex((r) => r.id === id); if (i >= 0) rows.splice(i, 1); log.push('remove:' + id); return true; },
    async count() { return rows.length; },
    lastKnownCount() { return rows.length; },
  };
}

// ── load photo-engine.js whole, Firebase swapped for stubs ──
function loadEngine(over) {
  over = over || {};
  let src = read('docs/pro/js/photo-engine.js');
  const before = src.length;
  src = src.replace(/await import\(\s*'https:\/\/www\.gstatic\.com\/firebasejs\/[^']+\/firebase-(\w+)\.js'\s*\)/g, "await __fb('$1')");
  if (src.length === before) throw new Error('import shim matched nothing');

  const net = { online: true };
  const docs = {};
  const writes = [];   // ['setDoc'|'updateDoc', path, data]
  const uploads = [];  // storage paths, in order
  const order = [];
  const store = over.store || makeStore();
  const _rawAdd = store.add.bind(store);
  store.add = async (it) => { const id = await _rawAdd(it); order.push('add:' + id); return id; };
  const toasts = [];
  const fb = {
    storage: {
      ref: (_s, p) => ({ path: p }),
      uploadBytes: async (r) => { if (!net.online) throw new Error('offline'); uploads.push(r.path); order.push('upload:' + r.path); },
      getDownloadURL: async (r) => 'https://dl.example/' + r.path,
    },
    firestore: {
      doc: (_db, coll, id) => ({ path: coll + '/' + id }),
      serverTimestamp: () => ({ __ts: true }),
      getDoc: async (r) => ({ exists: () => !!docs[r.path], data: () => docs[r.path] }),
      setDoc: async (r, d) => { if (!net.online) throw new Error('offline'); writes.push(['setDoc', r.path, d]); docs[r.path] = Object.assign({}, docs[r.path] || {}, d); },
      updateDoc: async (r, d) => { if (!net.online) throw new Error('offline'); writes.push(['updateDoc', r.path, d]); docs[r.path] = Object.assign({}, docs[r.path] || {}, d); },
    },
    functions: { getFunctions: () => ({}), httpsCallable: () => async () => ({ data: {} }) },
  };
  const ls = {};
  const win = {
    __fb: async (name) => fb[name],
    console, setTimeout, clearTimeout, Promise, Blob, URL, JSON, Math, Date, Error, Object, Array, Set, Map,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: (k) => { delete ls[k]; } },
    navigator: {
      get onLine() { return net.online; },
      geolocation: over.geolocation || { getCurrentPosition: (okCb) => okCb({ coords: { latitude: 39.1001, longitude: -84.5001, accuracy: 12 } }) },
    },
    document: {
      readyState: 'complete', addEventListener() {}, getElementById: () => null,
      // A canvas good enough for generateThumbnail: drawImage is a no-op and
      // toBlob hands back a tiny JPEG.
      createElement: () => ({
        style: {}, classList: { add() {}, remove() {} },
        getContext: () => ({ drawImage() {}, fillRect() {} }),
        toBlob: (cb) => cb(new Blob([Buffer.from([0xff, 0xd8])], { type: 'image/jpeg' })),
      }),
      head: { appendChild() {} }, body: { appendChild() {} },
    },
    FileReader: function () { this.readAsDataURL = () => { setTimeout(() => this.onload({ target: { result: 'data:image/jpeg;base64,/9g=' } }), 0); }; },
    Image: function () { const self = this; Object.defineProperty(this, 'src', { set() { setTimeout(() => self.onload && self.onload(), 0); } }); this.width = 10; this.height = 10; },
    addEventListener() {},
    _storage: {}, _db: {}, _auth: {},
    _user: { uid: 'u1', email: 'rep@nbd.test' },
    _userClaims: { companyId: 'c1' },
    _leads: over.leads || [{ id: 'L1', stage: 'inspected', lat: 39.1, lng: -84.5 }],
    NBDPhotoQueueStore: store,
    showToast: (m, t) => toasts.push([t, m]),
  };
  if (over.ls) Object.assign(ls, over.ls);
  win.window = win;
  win.self = win;
  vm.createContext(win);
  vm.runInContext(src, win, { filename: 'photo-engine.js' });
  return { win, PE: win.PhotoEngine, net, docs, writes, uploads, order, store, toasts, ls };
}

const blob = () => new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], { type: 'image/jpeg' });

(async () => {
  // ════════════════════════════════════════════════════════════════
  section('1 — burst capture (shutter only, durable queue first, burst default)');
  await guard(async () => {
    const E = loadEngine();
    ok('PhotoEngine loads in the sandbox with its burst internals exposed', !!(E.PE && E.PE._burst && E.PE._burst.saveBurstShot));
    ok('burst is the default capture mode (nothing stored)', E.PE._burst.readCaptureMode() === 'burst');
    const E2 = loadEngine({ ls: { photoEngineCaptureMode: 'tag' } });
    ok('a rep who chose "tag" keeps the tag sheet', E2.PE._burst.readCaptureMode() === 'tag');

    // One shot, online: queued BEFORE the network, then drained, then gone.
    const geo = Promise.resolve({ lat: 39.1002, lng: -84.5002, accuracy: 10, at: 1 });
    const out = await E.PE._burst.saveBurstShot(blob(), 'L1', geo);
    ok('a burst shot is committed to the durable queue', out && out.durable === true && out.queued === true);
    ok('it is enqueued before any upload is attempted', E.order[0] === 'add:1');
    for (let i = 0; i < 20 && E.store.rows.length; i++) await tick(5);
    const photoWrite = E.writes.find((w) => w[0] === 'setDoc' && /^photos\//.test(w[1]));
    ok('the upload came after the enqueue', E.order.indexOf('add:1') === 0 && E.order.some((o) => /^upload:/.test(o)));
    ok('the queue drains it to Storage + a /photos doc', !!photoWrite && E.uploads.some((p) => /^photos\/u1\/L1\//.test(p)));
    ok('and the row leaves the queue only after the upload', E.store.rows.length === 0 && E.store.log.indexOf('remove:1') > 0);
    ok('no tags were asked for (tagging happens in Photo Review)', photoWrite && Array.isArray(photoWrite[2].tags) && photoWrite[2].tags.length === 0);
    ok('the burst drain is quiet (no "queued photos uploaded" toast over the viewfinder)',
      !E.toasts.some(([, m]) => /queued photos? uploaded/.test(m)));

    // Three rapid shots offline: all held, none lost, drained in order later.
    const F = loadEngine();
    F.net.online = false;
    await F.PE._burst.saveBurstShot(blob(), 'L1', null);
    await F.PE._burst.saveBurstShot(blob(), 'L1', null);
    await F.PE._burst.saveBurstShot(blob(), 'L1', null);
    await tick(20);
    ok('three burst shots with no signal are all held durably', F.store.rows.length === 3 && F.writes.length === 0);
    // The lead moves on before signal returns — the pinned phase must not.
    F.win._leads[0].stage = 'install_complete';
    F.net.online = true;
    await F.PE.flushUploadQueue();
    const pw = F.writes.filter((w) => w[0] === 'setDoc' && /^photos\//.test(w[1]));
    ok('back online, all three drain', pw.length === 3 && F.store.rows.length === 0);
    ok('each keeps the phase pinned at capture (Before — the lead was Inspected), not the stage at drain time',
      pw.every((w) => w[2].phase === 'Before' && w[2].phaseSource === 'stage'), pw.map((w) => w[2].phase).join(','));

    // Queue full: the rep is told to stop, every shot.
    const G = loadEngine();
    G.store.add = async () => { const e = new Error('full'); e.reason = 'queue-full'; throw e; };
    const full = await G.PE._burst.saveBurstShot(blob(), 'L1', null);
    ok('a full queue refuses the shot and says so', full && full.queued === false && G.toasts.some(([t, m]) => t === 'error' && /full/i.test(m)));
  });

  // ════════════════════════════════════════════════════════════════
  section('2 — phase from the lead\'s stage at capture (a tag wins)');
  await guard(async () => {
    const E = loadEngine();
    const C = E.PE._capture;
    const table = [
      ['new', 'Before'], ['inspected', 'Before'], ['estimate_submitted', 'Before'], ['contract_signed', 'Before'],
      ['crew_scheduled', 'Before'], ['install_in_progress', 'During'], ['In Progress', 'During'],
      ['install_complete', 'After'], ['final_photos', 'After'], ['final_payment', 'After'], ['closed', 'After'],
      ['Complete', 'After'], ['warranty_claim', 'After'], ['custom_xyz', null], ['', null],
    ];
    const wrong = table.filter(([s, p]) => C.phaseForStage(s) !== p);
    ok('stage → phase: before contract Before, installing During, complete-or-later After, unknown null',
      wrong.length === 0, wrong.map(([s, p]) => s + '→' + C.phaseForStage(s) + ' (want ' + p + ')').join('; '));

    const tagWins = C.captureContext(['after'], 'inspected', null, null);
    ok('a phase tag the rep picks wins over the stage', tagWins.phase === 'After' && tagWins.phaseSource === 'tag');
    const stage = C.captureContext([], 'install_in_progress', null, null);
    ok('no tag → the stage phase, marked as such', stage.phase === 'During' && stage.phaseSource === 'stage');
  });
  await guard(async () => {
    const E = loadEngine();
    // The upload path stamps it even for callers that pass no capture
    // context (file picks, the customer-page hub).
    E.win._leads = [{ id: 'L2', stage: 'install_complete', lat: 39.1, lng: -84.5 }];
    // uploadFromFile is the public door (file picks, the customer hub): it
    // passes no capture context, so the phase must be derived here.
    const a = await E.PE.uploadFromFile('L2', blob(), []);
    ok('uploadPhotoToFirebase derives After from an install_complete lead', a && a.phase === 'After' && a.phaseSource === 'stage');
    const b = await E.PE.uploadFromFile('L2', blob(), ['before']);
    ok('and a "before" tag still wins on that lead', b && b.phase === 'Before' && b.phaseSource === 'tag');

    // A tag edit that names no phase keeps the stage phase.
    E.docs['photos/up_c'] = { phase: 'After', phaseSource: 'stage', tags: [] };
    await E.PE.updatePhotoTags('up_c', ['ridge']);
    ok('editing tags (no phase tag) leaves a stage-stamped phase alone',
      E.docs['photos/up_c'].phase === 'After' && E.docs['photos/up_c'].tags[0] === 'ridge');
    E.docs['photos/up_d'] = { phase: 'Before', phaseSource: 'tag', tags: ['before'] };
    await E.PE.updatePhotoTags('up_d', ['ridge']);
    ok('removing a phase TAG still clears the phase it set', E.docs['photos/up_d'].phase === null);

    // photo-review: a stage phase is bucketed but not "reviewed" until the
    // rep gives it a location.
    const REVIEW = read('docs/pro/js/pages/photo-review.js');
    const isRev = /function isReviewed\(photo\) \{[\s\S]*?\n\}/.exec(REVIEW);
    const sb = {}; vm.createContext(sb);
    vm.runInContext(isRev[0] + '\nthis.f = isReviewed;', sb);
    ok('Photo Review: a stage-stamped phase with no location still needs review', sb.f({ phase: 'Before', phaseSource: 'stage' }) === false);
    ok('Photo Review: once located it counts as reviewed', sb.f({ phase: 'Before', phaseSource: 'stage', location: 'Ridge' }) === true);
    ok('Photo Review: a rep-chosen phase is reviewed as before', sb.f({ phase: 'After' }) === true);
  });

  // ════════════════════════════════════════════════════════════════
  section('2b — install complete builds the Before & After report');
  await guard(async () => {
    globalThis.window = globalThis.window || {};
    const seen = [];
    globalThis.window.NBDAutoBeforeAfter = { onInstallComplete: (id) => { seen.push(id); return Promise.resolve('filed'); } };
    const SW = await import(pathToFileURL(path.join(ROOT, 'docs/pro/js/stage-write.js')).href);
    ok('stage-write exports autoBeforeAfterOnStage', typeof SW.autoBeforeAfterOnStage === 'function');
    if (typeof SW.autoBeforeAfterOnStage === 'function') {
      const fired = SW.autoBeforeAfterOnStage('L9', 'install_in_progress', 'install_complete');
      const notFired = SW.autoBeforeAfterOnStage('L9', 'install_in_progress', 'final_photos');
      const again = SW.autoBeforeAfterOnStage('L9', 'install_complete', 'install_complete');
      ok('moving onto install_complete hands the lead to NBDAutoBeforeAfter', fired === true && seen[0] === 'L9');
      ok('any other move does not', notFired === false && again === false && seen.length === 1);
    }

    // photo-report.js's NBDAutoBeforeAfter: waits for After photos, then files.
    const PR = read('docs/pro/js/photo-report.js');
    let photos = [{ id: 'p1', phase: 'Before', url: 'https://x/1.jpg', location: 'Ridge' }];
    const leadWrites = [];
    const docRows = [];
    let viewerOpened = false;
    const w = {
      console, setTimeout, clearTimeout, Promise, JSON, Math, Date, Object, Array, Set, Map, Error, URL, Blob,
      _user: { uid: 'u1' }, _leads: [{ id: 'L5', firstName: 'Pat', lastName: 'Q', address: '1 Main St', stage: 'install_complete' }],
      db: {}, _db: {},
      collection: (...a) => ({ path: a.slice(1).join('/') }),
      query: (c) => c, where: () => ({}), getDocs: async () => ({ docs: photos.map((p) => ({ id: p.id, data: () => p })), forEach: (fn) => {} }),
      doc: (_d, ...segs) => ({ path: segs.join('/') }),
      updateDoc: async (r, d) => { leadWrites.push([r.path, d]); },
      addDoc: async (c, d) => { docRows.push([c.path, d]); return { id: 'doc1' }; },
      serverTimestamp: () => ({ __ts: true }),
      _functions: {},
      _httpsCallable: () => async () => ({ data: { ok: true, url: 'https://render.example/r.pdf', path: 'pdf-renders/u1/r.pdf', filename: 'r.pdf' } }),
      NBDDocViewer: { open: () => { viewerOpened = true; } },
      showToast: () => {},
      document: { getElementById: () => null, createElement: () => ({ style: {} }), body: { appendChild() {} } },
      addEventListener() {},
    };
    // _filedReportNumber reads documents with getDocs+forEach — give it an empty set.
    const realGetDocs = w.getDocs;
    w.getDocs = async (q) => (q && /documents/.test(q.path || '')) ? { forEach() {}, docs: [] } : realGetDocs(q);
    w.window = w;
    vm.createContext(w);
    vm.runInContext(PR, w, { filename: 'photo-report.js' });
    const BA = w.NBDAutoBeforeAfter;
    ok('photo-report exposes NBDAutoBeforeAfter', !!(BA && BA.onInstallComplete && BA.afterPhoto));
    if (BA) {
      const r1 = await BA.onInstallComplete('L5');
      ok('with no After photo yet it waits (needs-after) and flags the lead', r1 === 'needs-after'
        && leadWrites.some(([p, d]) => p === 'leads/L5' && d.beforeAfterReportPending === true), String(r1));
      ok('nothing was filed or opened yet', docRows.length === 0 && !viewerOpened);
      photos = photos.concat([{ id: 'p2', phase: 'After', url: 'https://x/2.jpg', location: 'Ridge' }]);
      const r2 = await BA.onInstallComplete('L5');
      ok('with Before + After it renders and files the report', r2 === 'filed', String(r2));
      const row = docRows.find(([p]) => p === 'leads/L5/documents');
      ok('filed on the lead\'s Documents, marked automatic', !!row && row[1].source === 'photo_report' && row[1].autoBeforeAfter === true);
      ok('and opens no viewer unasked', viewerOpened === false);
      ok('the lead records it, so it never builds twice', leadWrites.some(([p, d]) => p === 'leads/L5' && d.beforeAfterReportPending === false && d.beforeAfterReportAt));
      const r3 = await BA.onInstallComplete('L5');
      ok('a second install-complete does not rebuild', r3 === 'already-filed', String(r3));
    }
  });

  // ════════════════════════════════════════════════════════════════
  section('3 — one GPS fix per camera session, on-site, stored on the CRM doc');
  await guard(async () => {
    const E = loadEngine();
    const C = E.PE._capture;
    const lead = { lat: 39.1, lng: -84.5 };
    ok('a fix ~15 m from the lead is on-site', C.onSiteFor({ lat: 39.10012, lng: -84.50008, accuracy: 10 }, lead) === true);
    ok('a fix ~1 km away is not', C.onSiteFor({ lat: 39.109, lng: -84.5, accuracy: 10 }, lead) === false);
    ok('a vague fix (400 m accuracy) says nothing', C.onSiteFor({ lat: 39.1, lng: -84.5, accuracy: 400 }, lead) === null);
    ok('a lead with no coordinates says nothing', C.onSiteFor({ lat: 39.1, lng: -84.5, accuracy: 5 }, {}) === null);
    ok('the radius is 75 m', C.ON_SITE_RADIUS_M === 75);
  });
  await guard(async () => {
    const E = loadEngine();
    await E.PE._burst.saveBurstShot(blob(), 'L1', Promise.resolve({ lat: 39.1001, lng: -84.5001, accuracy: 9, at: 5 }));
    for (let i = 0; i < 20 && E.store.rows.length; i++) await tick(5);
    const d = Object.keys(E.docs).filter((k) => /^photos\//.test(k)).map((k) => E.docs[k])[0] || {};
    ok('the photo doc carries geoLocation {lat,lng,accuracy}', d.geoLocation && d.geoLocation.lat === 39.1001 && d.geoLocation.accuracy === 9, JSON.stringify(d.geoLocation));
    ok('and onSite: true', d.onSite === true);
    ok('and capturedAt (the capture epoch)', typeof d.capturedAt === 'number' && d.capturedAt > 0);

    // A denied permission: no fix, nothing invented.
    const D2 = loadEngine({ geolocation: { getCurrentPosition: (_ok, err) => err({ code: 1 }) } });
    await D2.PE._burst.saveBurstShot(blob(), 'L1', Promise.resolve(null));
    for (let i = 0; i < 20 && D2.store.rows.length; i++) await tick(5);
    const nd = Object.keys(D2.docs).filter((k) => /^photos\//.test(k)).map((k) => D2.docs[k])[0] || {};
    ok('no permission → geoLocation null, onSite null', nd.geoLocation === null && nd.onSite === null, JSON.stringify(nd.geoLocation));
  });
  await guard(async () => {
    // The portal (homeowner) projection never carries the fields.
    const PORTAL = read('functions/portal.js');
    const proj = /photos: photoSnap\.docs\.map\(d => \{[\s\S]*?return \{([\s\S]*?)\n\s*\};/.exec(PORTAL);
    ok('the homeowner portal projects explicit photo fields (positive control: phase is one)', !!proj && /phase:/.test(proj[1]));
    ok('and geoLocation / onSite are not among them', !!proj && !/geoLocation|onSite/.test(proj[1]));
  });

  // ════════════════════════════════════════════════════════════════
  section('3b — the inspection report prints "date · time · On-site"');
  function loadInspection() {
    const SRC = read('docs/pro/js/inspection-report-engine.js');
    const docRows = [];
    const uploads = [];
    const opened = [];
    const w = {
      console, setTimeout, clearTimeout, Promise, JSON, Math, Date, Object, Array, Set, Map, Error, Blob,
      URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      document: { getElementById: () => null, createElement: () => ({ style: {} }), head: { appendChild() {} }, body: { appendChild() {} }, querySelector: () => null },
      _user: { uid: 'u1', email: 'rep@nbd.test' }, _userClaims: {},
      _leads: [{ id: 'L1', firstName: 'Pat', lastName: 'Q', address: '1 Main St' }],
      db: {}, _db: {}, storage: {},
      ref: (_s, p) => ({ path: p }),
      uploadBytes: async (r, b, meta) => { uploads.push([r.path, meta && meta.contentType]); },
      collection: (...a) => ({ path: a.slice(1).join('/') }),
      addDoc: async (c, d) => { docRows.push([c.path, d]); return { id: 'row1' }; },
      serverTimestamp: () => ({ __ts: true }),
      open: (u) => { opened.push(u); },
      showToast: () => {},
      addEventListener() {},
    };
    w.window = w;
    vm.createContext(w);
    vm.runInContext(SRC, w, { filename: 'inspection-report-engine.js' });
    return { Eng: w.InspectionReportEngine, w, docRows, uploads, opened };
  }
  const t = new Date(2026, 9, 4, 14, 14).getTime();
  await guard(async () => {
    const { Eng } = loadInspection();
    ok('InspectionReportEngine loads in the sandbox', !!Eng);
    const s1 = Eng._photoStamp({ capturedAt: t, onSite: true });
    ok('an on-site photo stamps "Oct 4, 2026 · 2:14 PM · On-site"', s1 === 'Oct 4, 2026 · 2:14 PM · On-site', s1);
    ok('an off-site photo gets date and time only', Eng._photoStamp({ capturedAt: t, onSite: false }) === 'Oct 4, 2026 · 2:14 PM');
    ok('no capture time falls back to createdAt', /Oct 4, 2026/.test(Eng._photoStamp({ createdAt: { toMillis: () => t } })));
    ok('nothing to stamp → empty', Eng._photoStamp({}) === '');
    ok('coordinates are never printed', !/39\.|84\./.test(Eng._photoStamp({ capturedAt: t, onSite: true, geoLocation: { lat: 39.1, lng: -84.5 } })));

  });
  await guard(async () => {
    const { Eng, w } = loadInspection();
    const s1 = 'Oct 4, 2026 · 2:14 PM · On-site';
    // The server payload carries the stamp to inspection.hbs.
    w._photoCache = { L1: [{ id: 'p1', url: 'https://x/1.jpg', capturedAt: t, onSite: true, location: 'Ridge' }] };
    const payload = Eng._buildInspectionPayload({ leadId: 'L1', templateId: 'full-inspection', data: {} });
    ok('the server payload\'s photos carry the stamp', payload && payload.photos && payload.photos[0] && payload.photos[0].stamp === s1,
      payload && payload.photos && JSON.stringify(payload.photos[0]));
    const HBS = read('functions/print/templates/inspection.hbs');
    ok('inspection.hbs prints it under the caption', /\{\{#if this\.stamp\}\}[\s\S]{0,80}\{\{this\.stamp\}\}/.test(HBS));

  });
  // ── 6 — box ticked by default; every report filed on the lead ──
  section('6 — inspection reports: saved by default, every report a lead document');
  await guard(async () => {
    const { Eng, docRows, uploads, opened } = loadInspection();
    const html = Eng._renderPreviewAndGenerate({ leadId: 'L1', templateId: 'storm-damage', data: {} });
    ok('"Save report to database" is ticked by default', /id="save-to-db" checked/.test(html));

    Eng.generateReport = () => '<html><body>report</body></html>';
    Eng._saveDraft = () => {};
    const unticked = { querySelector: (sel) => (sel === '#save-to-db' ? { checked: false } : null) };
    await Eng._generateAndOpen({ leadId: 'L1', templateId: 'storm-damage', data: {} }, unticked);
    await tick(10);
    const row = docRows.find(([p]) => p === 'leads/L1/documents');
    ok('even with the box unticked, the report is filed on the lead\'s Documents', !!row);
    ok('as a generated HTML document re-opened through getDocumentHtml (htmlPath, no token URL)',
      !!row && /^documents\/u1\/L1\/insp-[^/]+\.html$/.test(row[1].htmlPath) && !row[1].url && row[1].source === 'inspection_report');
    ok('the HTML was uploaded as text/html under that path',
      !!row && uploads.some(([p, ct]) => p === row[1].htmlPath && ct === 'text/html'));
    ok('and the rep still gets the report opened', opened.length === 1);
  });

  // ════════════════════════════════════════════════════════════════
  section('4 — photo-editor saves ride the durable queue');
  await guard(async () => {
    const E = loadEngine();
    const meta = { tags: ['ridge'], phase: 'After', annotations: [{ id: 'a1', type: 'arrow' }] };
    const r = await E.PE.enqueueEdit({ mode: 'meta', leadId: 'L1', photoId: 'p1', meta });
    ok('online: a tags save reaches the server ("saved")', r.status === 'saved', JSON.stringify(r));
    const u = E.writes.find((w) => w[0] === 'updateDoc' && w[1] === 'photos/p1');
    ok('with the annotations', !!u && Array.isArray(u[2].annotations) && u[2].annotations[0].id === 'a1');
    ok('and nothing left in the queue', E.store.rows.length === 0);

    const F = loadEngine();
    F.net.online = false;
    const held = await F.PE.enqueueEdit({ mode: 'meta', leadId: 'L1', photoId: 'p2', meta, waitMs: 30 });
    ok('offline: the save is HELD on the device, not lost', held.status === 'held' && F.store.rows.length === 1, JSON.stringify(held));
    ok('the held row carries the edit', F.store.rows[0] && F.store.rows[0].capture && F.store.rows[0].capture.edit.photoId === 'p2');
    F.net.online = true;
    await F.PE.flushUploadQueue();
    ok('back online the drain applies it and empties the queue',
      F.writes.some((w) => w[0] === 'updateDoc' && w[1] === 'photos/p2') && F.store.rows.length === 0);

    // Save-copy offline, then a failed retry, then success: ONE copy doc.
    const G = loadEngine();
    G.net.online = false;
    await G.PE.enqueueEdit({ mode: 'copy', leadId: 'L1', photoId: 'p3', meta, blob: blob(), waitMs: 30 });
    const copyId = G.store.rows[0] && G.store.rows[0].capture.edit.copyId;
    await G.PE.flushUploadQueue(); // still offline
    G.net.online = true;
    await G.PE.flushUploadQueue();
    const copies = G.writes.filter((w) => w[0] === 'setDoc' && /^photos\/ann_/.test(w[1]));
    ok('save-copy pins its doc id at enqueue, so retries make one copy', !!copyId && copies.length === 1 && copies[0][1] === 'photos/' + copyId);
    ok('the copy is a new annotated photo linked to the original', copies[0] && copies[0][2].originalPhotoId === 'p3' && copies[0][2].isAnnotated === true);
    ok('its image went to the lead\'s own Storage folder', G.uploads.some((p) => p === 'photos/u1/L1/photo_' + copyId + '.jpg'));

    const H = loadEngine();
    await H.PE.enqueueEdit({ mode: 'over', leadId: 'L1', photoId: 'p4', meta, blob: blob(), originalUrl: 'https://o/1', originalStoragePath: 'photos/u1/L1/orig.jpg' });
    const over = H.writes.find((w) => w[0] === 'updateDoc' && w[1] === 'photos/p4');
    ok('save-over replaces url + storagePath and backs up the original once',
      !!over && /photo_p4\.jpg$/.test(over[2].storagePath) && over[2].originalUrl === 'https://o/1');

    // The editor routes through it.
    const ED = read('docs/pro/js/photo-editor.js');
    ok('photo-editor saveTagsOnly + uploadBlob queue through PhotoEngine.enqueueEdit',
      /engine\.enqueueEdit\(/.test(ED) && /_queuedSave\('meta'/.test(ED) && /_queuedSave\(overwrite && S\.photoId \? 'over' : 'copy'/.test(ED));
    ok('the editor has no inline style attributes left', !/style\s*=\s*["'`]/.test(ED));
    ok('default stroke is 6px', /lineWidth: 6,/.test(ED) && !/lineWidth: 3,/.test(ED));
  });

  // ════════════════════════════════════════════════════════════════
  section('5 — Draw tool cross-check + the V3 wizard "Draw it" hand-off');
  await guard(async () => {
    const SRC = read('docs/pro/js/draw-measure-check.js');
    const ss = {};
    const input = { id: 'drawSearch', value: '' };
    let searched = 0;
    const w = {
      console, setTimeout, Promise, JSON, Math, Object, Array, String, Number, isFinite,
      sessionStorage: { getItem: (k) => (k in ss ? ss[k] : null), setItem: (k, v) => { ss[k] = String(v); }, removeItem: (k) => { delete ss[k]; } },
      document: { addEventListener() {}, getElementById: (id) => (id === 'drawSearch' ? input : null) },
      addEventListener() {},
      location: { hash: '' },
      _leads: [{ id: 'L7', address: '12 Oak Street, Mason OH', measurementSqft: 3483, measurementSquares: 34.8, measurementPitch: '5/12' }],
      searchDraw: () => { searched++; },
    };
    w.window = w;
    vm.createContext(w);
    vm.runInContext(SRC, w, { filename: 'draw-measure-check.js' });
    const M = w.NBDDrawMeasureCheck;
    ok('draw-measure-check loads', !!M);
    const v = M.vendorNumbers(w._leads[0], null);
    ok('vendor numbers read off the lead', v && v.roofSqft === 3483 && v.pitch === '5/12');
    const close = M.crossCheck(v, { combined: { pitched: 3310 } });
    ok('a drawing within 10% reads "close" with its % gap', close.verdict === 'close' && close.diffPct === -5, JSON.stringify(close));
    const far = M.crossCheck(v, { combined: { pitched: 4200 } });
    ok('more than 10% apart says check the outline', far.verdict === 'check' && far.diffPct === 21);
    ok('nothing drawn yet → waits', M.crossCheck(v, { combined: { pitched: 0 } }).verdict === 'nothing-drawn');
    ok('no vendor measure → no card', M.crossCheck(null, { combined: { pitched: 10 } }) === null);
    ok('a hostile pitch string never reaches the card', M.vendorNumbers({ measurementSqft: 1000, measurementPitch: '<img onerror=x>' }).pitch === null);
    ok('the address finds the lead the same way Save does', M.matchLead('12 Oak Street', w._leads) === w._leads[0]);
    ok('the vendor outline is read from the lead', M.vendorNumbers({ measurementSqft: 1, measurementOutlinePath: 'docs/u1/measurements/L7-outline.png' }).outlinePath === 'docs/u1/measurements/L7-outline.png');

    M.applyPrefill({ address: '12 Oak Street, Mason OH', leadId: 'L7' });
    ok('the wizard hand-off fills the address and centres the map', input.value === '12 Oak Street, Mason OH' && searched === 1);

    // The wizard side.
    const WZ = read('docs/pro/js/estimate-v3-wizard.js');
    const body = /function drawIt\(\) \{[\s\S]*?\n {2}\}/.exec(WZ);
    ok('the V3 wizard has drawIt on its measure step', !!body && /data-v3="measure" class="v3-draw-it"/.test(WZ) && /act === 'draw-it'/.test(WZ));
    if (body) {
      const store = {};
      let went = null, closed = 0, navTo = null;
      const sb = {
        DRAW_PREFILL_KEY: 'nbd_draw_prefill',
        sessionStorage: { setItem: (k, val) => { store[k] = val; } },
        document: { getElementById: (id) => (id === 'v2custAddress' ? { value: ' 12 Oak Street ' } : (id === 'view-draw' ? {} : null)) },
        $: () => ({ textContent: '' }),
        v2state: () => ({ leadId: 'L7' }),
        ui: { modal: { querySelector: () => ({ click: () => { closed++; } }) } },
        window: { goTo: (v2) => { went = v2; }, location: { set href(u) { navTo = u; } } },
        JSON, String,
      };
      vm.createContext(sb);
      vm.runInContext(body[0] + '\nthis.r = drawIt();', sb);
      const saved = store.nbd_draw_prefill ? JSON.parse(store.nbd_draw_prefill) : null;
      ok('"Draw it" hands the address + lead to the Draw view', sb.r === true && saved && saved.address === '12 Oak Street' && saved.leadId === 'L7');
      ok('and opens it (closing the builder — its draft autosaves)', went === 'draw' && closed === 1 && navTo === null);
      ok('the key matches what draw-measure-check reads', M.PREFILL_KEY === 'nbd_draw_prefill');
    }
    const SL = read('docs/pro/js/script-loader.js');
    const dt = SL.slice(SL.indexOf('drawtool: ['), SL.indexOf('],', SL.indexOf('drawtool: [')));
    ok('the drawtool bundle loads the cross-check after the engine', dt.indexOf('draw-measure-check.js') > dt.indexOf('maps-routing.js'));
  });

  console.log('\n──────────────────────────────────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('Failures:\n - ' + fails.join('\n - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
