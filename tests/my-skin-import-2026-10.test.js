/**
 * tests/my-skin-import-2026-10.test.js — My Skin bulk import, thumbnails, the
 * all-themes grid and the soft quota (slice B2).
 *
 *   1. matchImportName / planImport: the spec's cases, then EVERY live theme id
 *      (read from theme-engine.js, ids only, no pictures anywhere)
 *   2. parseZipDirectory against real zips built in-process, including every
 *      limit (entries, size, expansion, Zip64, encryption, damage)
 *   3. the soft quota and thumbnail paths
 *   4. contract: lazy module, no third-party unzip, worker CSP, no token URL,
 *      no innerHTML, cache-busters agree, nothing loaded at boot
 *
 * Run: node tests/my-skin-import-2026-10.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const L = require(path.join(ROOT, 'docs/pro/js/my-skin-logic.js'));

// The live ids and category ids, from the engine source.
const engine = read('docs/pro/js/theme-engine.js');
const body = engine.slice(engine.indexOf('const THEMES = {'));
const IDS = [...body.matchAll(/^    '([a-z0-9-]+)': \{/gm)].map((m) => m[1]);
const CATS = [...engine.matchAll(/^    \{ key: '([a-z]+)', label: '/gm)].map((m) => m[1]);

console.log('\n1. matchImportName');
{
  ok('POSITIVE CONTROL: the live id list was read (≥ 190 ids, ben-10 and 13 categories)', IDS.length >= 190 && IDS.indexOf('ben-10') !== -1 && CATS.length === 13, IDS.length + ' ids, ' + CATS.length + ' cats');
  const ids = ['pokemon', 'ben-10', 'ios26', 'duo-machine-red', 'obsidian-v5', 'mario'];
  const m = (p) => L.matchImportName(p, ids, ['popculture']);
  ok('exact id → image 1', JSON.stringify(m('pokemon.jpg')) === JSON.stringify({ kind: 'match', themeId: 'pokemon', index: 1 }));
  ok('<id>-2 .. <id>-6 → images 2..6', [2, 3, 4, 5, 6].every((n) => { const r = m('mario-' + n + '.png'); return r.kind === 'match' && r.themeId === 'mario' && r.index === n; }));
  ok('<id>-1 is image 1', m('mario-1.jpg').index === 1);
  ok('ben-10.jpg is the id ben-10 (image 1), never "ben" #10', m('ben-10.jpg').themeId === 'ben-10' && m('ben-10.jpg').index === 1);
  ok('ios26.jpg matches the id with no index', m('ios26.jpg').themeId === 'ios26' && m('ios26.jpg').index === 1);
  ok('duo-machine-red-2.jpg → duo-machine-red #2', m('duo-machine-red-2.jpg').themeId === 'duo-machine-red' && m('duo-machine-red-2.jpg').index === 2);
  ok('an id with a version suffix', m('obsidian-v5.webp').themeId === 'obsidian-v5');
  ok('uppercase and folders and .JPEG', m('Anime/POKEMON-2.JPEG').themeId === 'pokemon' && m('Anime/POKEMON-2.JPEG').index === 2 && m('a\\b\\mario.jpg').themeId === 'mario');
  ok('index 7, 0 and 99 are not slots', ['mario-7.jpg', 'mario-0.jpg', 'mario-99.jpg'].every((n) => m(n).kind === 'unmatched'));
  ok('an unknown name or a stem that is only a prefix of an id is unmatched', m('unknown.jpg').kind === 'unmatched' && m('ben.jpg').kind === 'unmatched' && m('duo-machine.jpg').kind === 'unmatched');
  ok('previews/, __MACOSX/, dotfiles, csv/md and category names are ignored',
    m('previews/pokemon.jpg').kind === 'ignored' && m('__MACOSX/._pokemon.jpg').kind === 'ignored' && m('.DS_Store').kind === 'ignored'
    && m('manifest.csv').kind === 'ignored' && m('README.md').kind === 'ignored' && m('popculture.jpg').kind === 'ignored');
  ok('a non-picture extension is ignored, not unmatched', m('pokemon.pdf').kind === 'ignored' && m('pokemon.svg').kind === 'ignored');
  ok('every accepted extension', ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic', 'heif'].every((e) => m('pokemon.' + e).kind === 'match'));
  ok('empty and nonsense input never throws', m('').kind === 'ignored' && m('/').kind === 'ignored' && L.matchImportName(null, null, null).kind === 'ignored');
}

console.log('\n2. every live theme id (ids only)');
{
  const cats = CATS;
  let bad = [];
  IDS.forEach((id) => {
    const r1 = L.matchImportName(id + '.jpg', IDS, cats), r1b = L.matchImportName('pack/' + cats[0] + '/' + id.toUpperCase() + '.PNG', IDS, cats);
    if (!(r1.kind === 'match' && r1.themeId === id && r1.index === 1)) bad.push(id + '.jpg');
    if (!(r1b.kind === 'match' && r1b.themeId === id && r1b.index === 1)) bad.push('folder/' + id);
    for (let n = 2; n <= 6; n++) {
      const r = L.matchImportName(id + '-' + n + '.jpg', IDS, cats);
      if (!(r.kind === 'match' && r.themeId === id && r.index === n)) bad.push(id + '-' + n);
    }
    if (L.matchImportName(id + '-7.jpg', IDS, cats).kind !== 'unmatched') bad.push(id + '-7');
  });
  ok('all ' + IDS.length + ' ids: <id>.jpg, <id>-2..6, folder + uppercase, -7 refused; 0 false matches', bad.length === 0, bad.slice(0, 8).join(', '));
  // an id that is itself "<other id>-<n>" would be read as the other theme's slideshow slot
  const clashes = [];
  IDS.forEach((id) => { const m = /^(.+)-(\d{1,2})$/.exec(id); if (m && IDS.indexOf(m[1]) !== -1 && Number(m[2]) >= 1 && Number(m[2]) <= 6) clashes.push(id); });
  ok('no live id collides with another id\'s slideshow slot (add one and this goes red on purpose)', clashes.length === 0, clashes.join(', '));
  ok('the 13 category previews are ignored by name', CATS.every((c) => L.matchImportName('previews/' + c + '.jpg', IDS, CATS).kind === 'ignored' && L.matchImportName(c + '.jpg', IDS, CATS).kind === 'ignored'));

  const files = [];
  IDS.slice(0, 40).forEach((id) => { files.push({ path: id + '.jpg', size: 1 }); files.push({ path: id + '-2.jpg', size: 1 }); });
  files.push({ path: 'previews/' + CATS[0] + '.jpg', size: 1 }, { path: 'manifest.csv', size: 1 }, { path: 'who-is-this.jpg', size: 1 }, { path: IDS[0] + '.png', size: 1 });
  const plan = L.planImport(files, IDS, CATS);
  ok('planImport: grouped by theme, ordered by index, 2 per theme', Object.keys(plan.themes).length === 40 && plan.themes[IDS[1]].map((x) => x.index).join() === '1,2');
  ok('planImport: ignored, unmatched and same-slot collisions are reported separately',
    plan.ignored === 2 && plan.unmatched.length === 1 && plan.unmatched[0].path === 'who-is-this.jpg' && plan.collisions.length === 1 && plan.collisions[0].path === IDS[0] + '.png');
}

console.log('\n3. parseZipDirectory (real zips)');
{
  // A minimal zip writer: stored (0) and deflate (8) entries, no CRC checking needed by the parser.
  function zip(entries, opts) {
    const o = opts || {};
    const parts = [], cds = []; let off = 0;
    entries.forEach((e) => {
      const name = Buffer.from(e.name, 'utf8');
      const data = e.dir ? Buffer.alloc(0) : Buffer.from(e.data);
      const method = e.method == null ? 8 : e.method;
      const comp = (method === 8 && !e.dir) ? zlib.deflateRawSync(data) : data;
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(e.flags || 0, 6); lh.writeUInt16LE(method, 8);
      lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
      parts.push(lh, name, comp);
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(e.flags || 0, 8); cd.writeUInt16LE(method, 10);
      cd.writeUInt32LE(e.zip64 ? 0xffffffff : comp.length, 20); cd.writeUInt32LE(e.declSize != null ? e.declSize : data.length, 24);
      cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(off, 42);
      cds.push(cd, name);
      off += 30 + name.length + comp.length;
    });
    const cdBuf = Buffer.concat(cds);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
    return Buffer.concat(parts.concat([cdBuf, eocd]));
  }
  const u8 = (b) => new Uint8Array(b.buffer, b.byteOffset, b.length);
  const z = zip([
    { name: 'pack/', dir: true, method: 0 },
    { name: 'pack/pokemon.jpg', data: 'x'.repeat(5000) },
    { name: 'pack/mario-2.jpg', data: 'hello', method: 0 },
    { name: 'pack/ünï.png', data: 'abc' },
  ]);
  const r = L.parseZipDirectory(u8(z), z.length);
  ok('lists entries with name, method and sizes', !r.error && r.entries.length === 4
    && r.entries[1].name === 'pack/pokemon.jpg' && r.entries[1].method === 8 && r.entries[1].size === 5000 && r.entries[2].method === 0 && r.entries[2].size === 5);
  ok('marks directories; utf-8 names survive', r.entries[0].dir === true && r.entries[3].name === 'pack/ünï.png');
  ok('totalUncompressed counts files only', r.totalUncompressed === 5008);

  // The deflate assumption itself: Node's DecompressionStream('deflate-raw') reads what the zip stores.
  const e1 = r.entries[1];
  const lhNameLen = z.readUInt16LE(e1.offset + 26), lhExtraLen = z.readUInt16LE(e1.offset + 28);
  const comp = z.subarray(e1.offset + 30 + lhNameLen + lhExtraLen, e1.offset + 30 + lhNameLen + lhExtraLen + e1.compSize);
  ok('a deflate entry inflates to its declared size (raw deflate)', zlib.inflateRawSync(comp).length === 5000);

  ok('not a zip', /doesn.t look like a zip/.test(L.parseZipDirectory(new Uint8Array(100), 100).error));
  ok('an empty file', /empty/.test(L.parseZipDirectory(new Uint8Array(0), 0).error));
  ok('a zip over 500 MB is refused before anything is read', /over 500 MB/.test(L.parseZipDirectory(u8(z), 501 * 1024 * 1024).error));
  const many = zip(Array.from({ length: 401 }, (_, i) => ({ name: 'f' + i + '.jpg', data: 'a', method: 0 })));
  ok('more than 400 entries is refused', /401 files/.test(L.parseZipDirectory(u8(many), many.length).error));
  const four = zip(Array.from({ length: 400 }, (_, i) => ({ name: 'f' + i + '.jpg', data: 'a', method: 0 })));
  ok('400 entries is allowed', !L.parseZipDirectory(u8(four), four.length).error);
  const big = zip([{ name: 'a.jpg', data: 'a', declSize: 21 * 1024 * 1024 }]);
  ok('an entry declaring > 20 MB is flagged tooBig', L.parseZipDirectory(u8(big), big.length).entries[0].tooBig === true);
  const bomb = zip(Array.from({ length: 80 }, (_, i) => ({ name: 'b' + i + '.jpg', data: 'a', declSize: 20 * 1024 * 1024 })));
  ok('an archive expanding past 1.5 GB is refused (zip bomb)', /1\.5 GB/.test(L.parseZipDirectory(u8(bomb), bomb.length).error));
  const z64 = zip([{ name: 'a.jpg', data: 'a', zip64: true }]);
  ok('Zip64 entries are flagged, never read', L.parseZipDirectory(u8(z64), z64.length).entries[0].zip64 === true);
  const enc = zip([{ name: 'a.jpg', data: 'a', flags: 1 }]);
  ok('encrypted entries are flagged', L.parseZipDirectory(u8(enc), enc.length).entries[0].encrypted === true);
  const tail = z.subarray(z.length - 60);
  const short = L.parseZipDirectory(u8(tail), z.length);
  ok('a tail shorter than the file list asks for more bytes', short.error === 'tail-too-short' && short.needFrom > 0 && short.cdSize > 0);
  const dmg = Buffer.from(z);
  const cdStart = dmg.readUInt32LE(dmg.length - 22 + 16);
  dmg.writeUInt32LE(0xdeadbeef, cdStart);   // the first directory record's signature
  ok('a damaged directory is an error, not a throw', /damaged/.test(L.parseZipDirectory(u8(dmg), dmg.length).error));
}

console.log('\n4. soft quota and thumbnails');
{
  const img = (id, bytes, extra) => Object.assign({ id: id, path: 'skins/u1/themes/pokemon/' + id, v: 1, w: 1, h: 1, bytes: bytes, type: 'image/webp' }, extra || {});
  const cfg = L.normalize({ themes: { pokemon: { images: [img('lq3x9a1b2c', 100 * 1048576), img('lq3x9a1b2d', 50 * 1048576)] }, mario: { images: [img('lq3x9a1b2c', 100 * 1048576)] } } });
  ok('usageBytes counts distinct objects once', L.usageBytes(cfg) === 150 * 1048576);
  const cfg2 = L.normalize({ themes: { pokemon: { images: [img('lq3x9a1b2c', 100 * 1048576), img('lq3x9a1b2d', 150 * 1048576)] } } });
  ok('quotaCheck: under, exactly at, and over 300 MB',
    L.quotaCheck(cfg2, 49 * 1048576).ok && L.quotaCheck(cfg2, 50 * 1048576).ok && !L.quotaCheck(cfg2, 50 * 1048576 + 1).ok);
  ok('quotaCheck reports used / limit / after', (function () { const q = L.quotaCheck(cfg2, 10); return q.used === 250 * 1048576 && q.limit === 300 * 1048576 && q.after === q.used + 10; })());
  ok('the soft cap is 300 MB and the import estimate is under 1', L.QUOTA_SOFT_BYTES === 300 * 1048576 && L.STORED_RATIO_ESTIMATE > 0 && L.STORED_RATIO_ESTIMATE < 1);
  const t = L.normalize({ themes: { pokemon: { images: [img('lq3x9a1b2c', 1, { thumb: true }), img('lq3x9a1b2d', 1)] } } }).themes.pokemon.images;
  ok('trustedThumbPath: <path>_t only when the entry says it has one, only for the caller\'s own prefix',
    L.trustedThumbPath('u1', t[0]) === 'skins/u1/themes/pokemon/lq3x9a1b2c_t' && L.trustedThumbPath('u1', t[1]) === null && L.trustedThumbPath('u2', t[0]) === null);
  ok('the thumb flag round-trips and defaults to false', t[0].thumb === true && t[1].thumb === false);
  ok('a themeId/imageId with _t is still not a valid image id (only the object name carries it)', L.themeStoragePath('u1', 'pokemon', 'lq3x9a1b2c_t') === null);
}

console.log('\n5. contract');
{
  const M = strip(read('docs/pro/js/my-skin-import.js'));
  const J = strip(read('docs/pro/js/my-skin.js'));
  const W = strip(read('docs/pro/js/my-skin-encode-worker.js'));
  const D = read('docs/pro/dashboard.html');
  ok('the import module is lazy: no script tag for it anywhere on the pages', !/my-skin-import\.js/.test(D) && !/my-skin-import\.js/.test(read('docs/pro/customer.html')));
  ok('my-skin.js loads it on demand from a same-origin path', /s\.src = '\/pro\/js\/my-skin-import\.js\?v=\d+'/.test(J) && /function openTool\(kind\)/.test(J));
  ok('no third-party unzip library is referenced', !/fflate|jszip|pako|zip\.js/i.test(M));
  ok('zips use the browser\'s own deflate-raw inflate', /new DecompressionStream\('deflate-raw'\)/.test(M) && /function canInflate/.test(M));
  ok('an entry that inflates past its declared size is refused', /total > limit/.test(M) && /b\.size !== e\.size/.test(M));
  ok('no token download URL, no fetch of a blob: URL', !/getDownloadURL/.test(M) && !/fetch\(/.test(M));
  ok('plain DOM only: no innerHTML, no inline handlers', !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(M) && !/\.on(click|change|input)\s*=/.test(M));
  ok('files are re-encoded before upload (worker or the page\'s canvas encode)', /encodeFile\(file\)/.test(M) && /I\.encode\(file, spec, true, true\)/.test(M) && /new Worker\(WORKER_URL\)/.test(M));
  ok('3 at a time, theme entries in batches of 25', /CONCURRENCY = 3, BATCH = 25/.test(M) && /batchN >= BATCH/.test(M));
  ok('pause, cancel, retry, resume, beforeunload warning',
    /S\.paused/.test(M) && /S\.cancelled/.test(M) && /function retryFailed/.test(M) && /RESUME_KEY = 'nbd_myskin_import'/.test(M) && /beforeunload/.test(M) && /Import in progress\./.test(M));
  ok('the soft quota blocks the start button and each file', /!t\.files \|\| !q\.ok/.test(M) && /Background storage is full \(300 MB\)/.test(M));
  ok('the worker never touches the DOM or window', !/\bwindow\b|\bdocument\b/.test(W) && /new OffscreenCanvas/.test(W) && /importScripts\('my-skin-logic\.js\?v=\d+'\)/.test(W));
  const v = (src, re) => (src.match(re) || [])[1];
  ok('the worker imports the same logic cache-buster the pages load',
    v(read('docs/pro/js/my-skin-encode-worker.js'), /my-skin-logic\.js\?v=(\d+)/) === v(D, /js\/my-skin-logic\.js\?v=(\d+)/)
    && v(D, /js\/my-skin-logic\.js\?v=(\d+)/) === v(read('docs/pro/customer.html'), /js\/my-skin-logic\.js\?v=(\d+)/));
  const fb = JSON.parse(read('firebase.json'));
  const csps = [];
  (function walk(o) { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if (o.key === 'Content-Security-Policy' && typeof o.value === 'string') csps.push(o.value); Object.keys(o).forEach((k) => walk(o[k])); } })(fb);
  const proCsp = csps.filter((c) => /img-src[^;]*blob:/.test(c) && /script-src 'self'/.test(c));
  ok('POSITIVE CONTROL: found the app CSP blocks', proCsp.length >= 1, csps.length + ' csp values');
  ok('every app CSP allows a same-origin worker', proCsp.every((c) => /worker-src 'self'/.test(c)));
  ok('the dashboard\'s boot weight is unchanged by the lazy files', !/my-skin-encode-worker|my-skin-import/.test(D.replace(/<!--[\s\S]*?-->/g, '')));
  ok('the picker bubbles carry the theme key for hover prefetch', /d\.dataset\.themeKey = key/.test(read('docs/pro/js/maps.js')));
  ok('hover prefetch: debounced 150 ms, 3 at once, not on phones or Data Saver',
    /setTimeout\(function \(\) \{[\s\S]*?\}, 150\)/.test(J) && /prefInflight >= 3/.test(J) && /max-width: 600px/.test(J) && /saveData/.test(J));
  ok('thumbnails: 256 px, uploaded beside the picture as <path>_t, deleted with it',
    /L\(\)\.THUMB_WIDTH/.test(J) && /path \+ '_t'/.test(J) && /p \+ '_t'/.test(J));
  ok('the grid shows thumbnails lazily (IntersectionObserver, rootMargin 200px)', /rootMargin: '200px'/.test(M) && /new IntersectionObserver/.test(M));
  ok('a grid-picked theme is edited without being applied (Preview applies it)', /data-myskin-theme-preview/.test(J) && /editTarget/.test(J));
  const S = read('storage.rules');
  ok('storage rules: the imageId allows only an optional _t', /imageId\.matches\('\^\[a-z0-9\]\{8,16\}\(_t\)\?\$'\)/.test(S));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
