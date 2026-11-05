/**
 * tests/mesh-hail-2026-11-04.test.js
 *
 * MRMS MESH radar hail swaths (functions/integrations/mesh-hail-logic.js,
 * mesh-hail.js, docs/pro/js/hail-mesh-swaths.js, layouts/mission.js).
 *
 * The fixtures are SYNTHETIC GRIB2 messages built here byte by byte in the
 * exact shape NOAA ships (template 3.0 grid, 5.41 PNG packing, 16-bit grey,
 * R=-30 E=0 D=1), with every PNG row filter type 0–4 used, so the decoder is
 * proven on each filter and the tracer on known shapes: a block with a hole,
 * two cells touching only at a corner, a one-cell speck. Validated against
 * real data outside CI on 2026-11-04 (MRMS 2026-04-15 12Z, upper Midwest):
 * 84 of 106 ground reports of 1"+ hail fell inside the 0.75" swath, and 4
 * after shifting the swath 1° east — see the doc note.
 *
 * Run: node tests/mesh-hail-2026-11-04.test.js
 */
'use strict';

process.env.TZ = 'Pacific/Auckland';

const path = require('path');
const zlib = require('zlib');
const Module = require('module');
const ROOT = path.join(__dirname, '..');
const M = require(path.join(ROOT, 'functions/integrations/mesh-hail-logic.js'));
const HM = require(path.join(ROOT, 'docs/pro/js/hail-mesh-swaths.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
function throws(fn, re) { try { fn(); return false; } catch (e) { return re.test(String(e.message)); } }

// ── fixture builders ─────────────────────────────────────────────────────
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_T[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function paeth(a, b, c) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
// 16-bit grey PNG; row y uses filter type y % 5 (all five exercised).
function png16(w, h, vals) {
  const stride = w * 2, rows = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const raw = Buffer.alloc(stride);
    for (let x = 0; x < w; x++) raw.writeUInt16BE(vals[y * w + x], 2 * x);
    const ft = y % 5, out = Buffer.alloc(stride + 1);
    out[0] = ft;
    for (let i = 0; i < stride; i++) {
      const a = i >= 2 ? raw[i - 2] : 0, b = prev[i], c = i >= 2 ? prev[i - 2] : 0;
      const pred = ft === 0 ? 0 : ft === 1 ? a : ft === 2 ? b : ft === 3 ? (a + b) >> 1 : paeth(a, b, c);
      out[i + 1] = (raw[i] - pred) & 0xff;
    }
    rows.push(out); prev = raw;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 16; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
function sec(n, body) { const b = Buffer.alloc(5 + body.length); b.writeUInt32BE(5 + body.length, 0); b[4] = n; body.copy(b, 5); return b; }
// GRIB2 with NOAA's MESH layout; opts override templates for negative tests.
function grib(w, h, mm, o) {
  const opt = o || {};
  const s3 = Buffer.alloc(67); // section 3 minus its 5-byte header
  s3.writeUInt32BE(w * h, 1); s3.writeUInt16BE(opt.gridTmpl == null ? 0 : opt.gridTmpl, 7);
  s3.writeUInt32BE(w, 25); s3.writeUInt32BE(h, 29);
  s3.writeInt32BE(Math.round(opt.lat1 * 1e6), 41); s3.writeUInt32BE(Math.round((opt.lon1 + 360) * 1e6), 45);
  s3.writeInt32BE(Math.round((opt.lat1 - (h - 1) * 0.01) * 1e6), 50); s3.writeUInt32BE(Math.round((opt.lon1 + 360 + (w - 1) * 0.01) * 1e6), 54);
  s3.writeUInt32BE(10000, 58); s3.writeUInt32BE(10000, 62); s3[66] = opt.scan == null ? 0 : opt.scan;
  const s5 = Buffer.alloc(16);
  s5.writeUInt32BE(w * h, 0); s5.writeUInt16BE(opt.dataTmpl == null ? 41 : opt.dataTmpl, 4);
  s5.writeFloatBE(-30, 6); s5.writeInt16BE(0, 10); s5.writeInt16BE(1, 12); s5[14] = 16;
  const X = mm.map((v) => (v <= 0 ? 0 : Math.round(v * 10) + 30)); // mm = (X - 30) / 10
  const body = Buffer.concat([sec(1, Buffer.alloc(16)), sec(3, s3), sec(4, Buffer.alloc(29)), sec(5, s5), sec(6, Buffer.from([opt.bitmap == null ? 255 : opt.bitmap])), sec(7, png16(w, h, X)), Buffer.from('7777', 'ascii')]);
  const head = Buffer.alloc(16); head.write('GRIB', 0, 'ascii'); head[7] = 2; head.writeBigUInt64BE(BigInt(16 + body.length), 8);
  return Buffer.concat([head, body]);
}

// A 14 × 10 grid at 39.20 N / -84.60 (inside the service box). Inches drawn:
//   rows 1–5, cols 1–5: a 5×5 block of 1.2" with a 0" hole at (3,3)
//   (2,2) raised to 2.3" (the 2" band, inside the block)
//   (7,1)+(8,1) and (9,2)+(10,2): 0.9" pairs touching only at a corner (two regions)
//   cell (12,8): a lone 1.0" speck (dropped: under 2 cells)
const W = 14, H = 10, LAT1 = 39.2, LON1 = -84.6;
const IN = new Array(W * H).fill(0);
const set = (x, y, inches) => { IN[y * W + x] = inches; };
for (let y = 1; y <= 5; y++) for (let x = 1; x <= 5; x++) set(x, y, 1.2);
set(3, 3, 0); set(2, 2, 2.3);
set(7, 1, 0.9); set(8, 1, 0.9); set(9, 2, 0.9); set(10, 2, 0.9);
set(12, 8, 1.0);
const BUF = grib(W, H, IN.map((v) => v * 25.4), { lat1: LAT1, lon1: LON1 });
const BOX = { minLat: LAT1 - (H - 1) * 0.01 - 0.001, maxLat: LAT1 + 0.001, minLon: LON1 - 0.001, maxLon: LON1 + (W - 1) * 0.01 + 0.001 };

console.log('\nGRIB2 + PNG decode');
const g = M.parseGrib2(BUF);
ok('grid read: 14 × 10, 0.01°, first point 39.2 / -84.6', g.ni === W && g.nj === H && Math.abs(g.di - 0.01) < 1e-9 && Math.abs(g.lat1 - LAT1) < 1e-6 && Math.abs(g.lon1 - LON1) < 1e-6, JSON.stringify({ ni: g.ni, nj: g.nj, lat1: g.lat1, lon1: g.lon1 }));
const all = M.decodePngRows(g.png, 0, H);
const wantX = IN.map((v) => (v <= 0 ? 0 : Math.round(v * 25.4 * 10) + 30));
ok('every pixel decodes exactly, across PNG filters 0–4', all.data.every((v, i) => v === wantX[i]));
// The shape fixture is flat enough that Paeth often equals "Up"; seeded
// noise makes every filter's prediction differ (break-test 2026-11-04: a
// Paeth→Up mutation survived the shape fixture alone).
{
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) % 65536;
  const NW = 23, NH = 11, noise = Array.from({ length: NW * NH }, rnd);
  const dn = M.decodePngRows(png16(NW, NH, noise), 0, NH);
  ok('seeded noise decodes exactly through filters 0–4 (Paeth included)', dn.data.every((v, i) => v === noise[i]));
}
const part = M.decodePngRows(g.png, 3, 6);
ok('a row window decodes the same pixels', part.rows === 3 && part.data.every((v, i) => v === wantX[3 * W + i]));
const c = M.cropMm(g, BOX);
ok('crop covers the whole fixture grid', c.cols === W && c.rows === H, c.cols + 'x' + c.rows);
ok('mm = (X − 30)/10, so a 1.2" cell reads 30.5 mm', Math.abs(c.grid[1 * W + 1] - 30.5) < 0.05, String(c.grid[W + 1]));
ok('no-hail cells read 0, never negative', c.grid[0] === 0 && Math.min.apply(null, Array.from(c.grid)) === 0);
ok('maxIn reads the 2.3" cell', Math.abs(M.maxMm(c) / 25.4 - 2.3) < 0.01);

console.log('\nformat drift fails loudly (never a silent wrong map)');
ok('not GRIB → throws', throws(() => M.parseGrib2(Buffer.from('nope'.repeat(10))), /not GRIB/));
ok('another grid template → throws', throws(() => M.parseGrib2(grib(W, H, IN, { lat1: LAT1, lon1: LON1, gridTmpl: 30 })), /grid template/));
ok('another packing (not PNG) → throws', throws(() => M.parseGrib2(grib(W, H, IN, { lat1: LAT1, lon1: LON1, dataTmpl: 40 })), /5\.41/));
ok('a bitmap section → throws', throws(() => M.parseGrib2(grib(W, H, IN, { lat1: LAT1, lon1: LON1, bitmap: 0 })), /bitmap/));
ok('another scan order → throws', throws(() => M.parseGrib2(grib(W, H, IN, { lat1: LAT1, lon1: LON1, scan: 64 })), /scan mode/));

console.log('\nbands → polygons');
const doc = M.buildDayDoc(c, { ymd: '2026-06-26', key: 'k', bbox: BOX });
const bands = JSON.parse(doc.bandsJson);
const band = (inch) => bands.find((b) => b.minIn === inch) || { polygons: [] };
ok('0.75" band: the block + the two corner-touching pairs (1-cell speck dropped)', band(0.75).polygons.length === 3, String(band(0.75).polygons.length));
const block = band(0.75).polygons.find((p) => p.cells === 25);
ok('the block outer ring spans 25 cells (its hole is a separate ring)', !!block, JSON.stringify(band(0.75).polygons.map((p) => p.cells)));
ok('the block carries its one hole', block && block.holes.length === 1, block && String(block.holes.length));
ok('corner-touching pairs stay two 2-cell regions (not one figure-8)', band(0.75).polygons.filter((p) => p !== block).map((p) => p.cells).join(',') === '2,2',
  band(0.75).polygons.map((p) => p.cells).join(','));
ok('1" band: block only (0.9" cells excluded; 1.0" speck is 1 cell, dropped)', band(1).polygons.length === 1, String(band(1).polygons.length));
ok('1.5" band: just the 2.3" cell — 1 cell, dropped as a speck', band(1.5).polygons.length === 0);
ok('empty bands are left out of the doc', bands.every((b) => b.polygons.length > 0) && doc.bandCount === bands.length);
ok('doc says what it is', doc.product === 'MRMS MESH_Max_1440min' && doc.maxIn === 2.3 && doc.polygonCount === 4, JSON.stringify({ maxIn: doc.maxIn, n: doc.polygonCount }));

console.log('\npolygon geometry is where the cells are');
const lats = block.outer.map((p) => p[0]), lngs = block.outer.map((p) => p[1]);
// Block = cols 1–5, rows 1–5; each cell spans ±0.005° around its point.
const near = (a, b) => Math.abs(a - b) < 1e-6;
ok('block west/east edges at -84.595 / -84.545', near(Math.min(...lngs), -84.595) && near(Math.max(...lngs), -84.545), Math.min(...lngs) + ' ' + Math.max(...lngs));
ok('block north/south edges at 39.195 / 39.145', near(Math.max(...lats), 39.195) && near(Math.min(...lats), 39.145), Math.max(...lats) + ' ' + Math.min(...lats));
ok('outer ring has only corners (collinear points dropped): a square = 4', block.outer.length === 4, String(block.outer.length));
const hole = block.holes[0], hl = hole.map((p) => p[0]), hg = hole.map((p) => p[1]);
ok('the hole is cell (3,3): 39.175–39.165 / -84.575–-84.565',
  near(Math.max(...hl), 39.175) && near(Math.min(...hl), 39.165) && near(Math.min(...hg), -84.575) && near(Math.max(...hg), -84.565), JSON.stringify(hole));

console.log('\nwhich file closes the storm day');
const day = 'CONUS/MESH_Max_1440min_00.50/20260626/MRMS_MESH_Max_1440min_00.50_20260626-';
ok('the 12:00:00 file when present', M.pickFile([day + '113000.grib2.gz', day + '120000.grib2.gz', day + '123000.grib2.gz'], '20260626') === day + '120000.grib2.gz');
ok('else the latest one before 12:00', M.pickFile([day + '110000.grib2.gz', day + '113000.grib2.gz', day + '123000.grib2.gz'], '20260626') === day + '113000.grib2.gz');
ok('never a file after 12:00, never another day', M.pickFile([day + '123000.grib2.gz', 'x/MRMS_MESH_Max_1440min_00.50_20260625-120000.grib2.gz'], '20260626') === null);
ok('S3 listing XML parsed and sorted', JSON.stringify(M.parseListXml('<Key>b</Key><x/><Key>a</Key>')) === '["a","b"]');
ok('list URL is the public bucket, day prefix', M.listUrl('2026-06-26') === 'https://noaa-mrms-pds.s3.amazonaws.com/?list-type=2&prefix=' + encodeURIComponent('CONUS/MESH_Max_1440min_00.50/20260626/'));
ok('bad day refused', throws(() => M.compactYmd('6/26/2026'), /bad ymd/));

console.log('\ncron: dark gate + one end-to-end day (fakes)');
(async () => {
  const stubs = {
    './heartbeat': { onSchedule: (opts, fn) => Object.assign(fn, { __opts: opts }) },
    'firebase-functions/v2': { logger: { info() {}, warn() {} } },
    'firebase-admin/firestore': { getFirestore: () => { throw new Error('real Firestore touched'); }, FieldValue: { serverTimestamp: () => 'TS' } },
    './killswitch': { getFlags: async () => ({}) },
  };
  const real = Module._load;
  Module._load = function (request) { if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request]; return real.apply(this, arguments); };
  let C;
  try { C = require(path.join(ROOT, 'functions/integrations/mesh-hail.js')); } finally { Module._load = real; }
  const T = C._test;
  ok('scheduled daily 13:20 UTC', C.meshHailCron.__opts.schedule === '20 13 * * *' && C.meshHailCron.__opts.timeZone === 'Etc/UTC');

  let fetches = 0;
  const writes = [];
  const fakeDb = { doc: (p) => ({ set: async (d) => { writes.push([p, d]); } }) };
  const gz = zlib.gzipSync(grib(W, H, IN.map((v) => v * 25.4), { lat1: LAT1, lon1: LON1 }));
  const fakeFetch = async (url, as) => {
    fetches++;
    if (as === 'text') return '<Key>' + day + '120000.grib2.gz</Key>';
    return gz;
  };
  const now = new Date(Date.UTC(2026, 5, 26, 13, 20));
  const dark = await T.meshHailHandler({ getFlags: async () => ({ meshHailEnabled: 'true' }), fetchOk: fakeFetch, db: fakeDb, now });
  ok('dark unless the flag is exactly true (string "true" is not)', dark.status === 'dark' && fetches === 0 && writes.length === 0);
  const off = await T.meshHailHandler({ getFlags: async () => ({}), fetchOk: fakeFetch, db: fakeDb, now });
  ok('dark with no flag at all', off.status === 'dark' && fetches === 0);
  const on = await T.meshHailHandler({ getFlags: async () => ({ meshHailEnabled: true }), fetchOk: fakeFetch, db: fakeDb, now });
  ok('flag on: lists, fetches, writes hail_mesh/2026-06-26', on.status === 'ok' && fetches === 2 && writes.length === 1 && writes[0][0] === 'hail_mesh/2026-06-26', JSON.stringify(on));
  ok('written doc has the bands and a server timestamp', writes[0] && typeof writes[0][1].bandsJson === 'string' && writes[0][1].fetchedAt === 'TS' && writes[0][1].maxIn === 2.3);
  // The SERVICE_BBOX crop: the fixture grid sits inside it, so the same cells come out.
  ok('production crop (service box) still finds the block', writes[0] && JSON.parse(writes[0][1].bandsJson).some((b) => b.minIn === 1 && b.polygons.length === 1));
  writes.length = 0; fetches = 0;
  const miss = await T.meshHailHandler({ getFlags: async () => ({ meshHailEnabled: true }), fetchOk: async () => '<Key>nothing</Key>', db: fakeDb, now });
  ok('no file for the day: no doc written (never a fake "no hail")', miss.status === 'no-file' && writes.length === 0);
  ok('UTC day, not the Auckland local day', T.utcYmd(new Date(Date.UTC(2026, 5, 26, 23, 30))) === '2026-06-26');

  console.log('\nclient: stored days → map swaths');
  const sw = HM.toSwaths({ ymd: '2026-06-26', bandsJson: JSON.stringify(bands) });
  ok('one swath per polygon', sw.length === 4, String(sw.length));
  ok('rings = [outer, ...holes] (Leaflet hole order)', sw.some((s) => s.rings.length === 2) && sw.every((s) => Array.isArray(s.rings[0][0])));
  ok('titles say radar estimate + NOAA MRMS + the day', sw.every((s) => /Radar estimate \(NOAA MRMS\)/.test(s.title) && /Jun 26/.test(s.title)), sw[0] && sw[0].title);
  ok('colour rule matches MapView: 1.75"+ red, else gold', HM.levelFor(2) === 'red' && HM.levelFor(1.5) === 'gold');
  ok('bad JSON / missing day → no swaths, no throw', HM.toSwaths({ ymd: '2026-06-26', bandsJson: '{oops' }).length === 0 && HM.toSwaths({ bandsJson: '[]' }).length === 0 && HM.toSwaths(null).length === 0);
  ok('last 3 days, newest first, across a month edge', JSON.stringify(HM.recentYmds('2026-07-01', 3)) === '["2026-07-01","2026-06-30","2026-06-29"]');
  const both = HM.allSwaths([{ ymd: '2026-06-27', bandsJson: JSON.stringify(bands) }, { ymd: '2026-06-26', bandsJson: JSON.stringify(bands) }]);
  ok('several days: oldest first so the newest draws on top', both[0].id.indexOf('2026-06-26') > 0 && both[both.length - 1].id.indexOf('2026-06-27') > 0);
  const got = await HM.load({ db: {}, today: '2026-06-27', days: 2, doc: (db, col, id) => col + '/' + id,
    getDoc: async (ref) => ref === 'hail_mesh/2026-06-26' ? { exists: () => true, data: () => ({ bandsJson: '[]', maxIn: 0 }) } : { exists: () => false } });
  ok('load: one getDoc per day, missing days skipped, ymd stamped', got.length === 1 && got[0].ymd === '2026-06-26');
  const broken = await HM.load({ db: {}, today: '2026-06-27', doc: () => 'x', getDoc: async () => { throw new Error('denied'); } });
  ok('load: a failed read resolves [] (other layers keep drawing)', Array.isArray(broken) && broken.length === 0);

  console.log('\nmission map draws the layer');
  const fs = require('fs');
  const mission = fs.readFileSync(path.join(ROOT, 'docs/pro/js/layouts/mission.js'), 'utf8').replace(/\/\/.*$/mg, '');
  ok('Watch map appends S.mesh to its swaths', /map\.setSwaths\(sw\.concat\(S\.mesh \|\| \[\]\)\)/.test(mission));
  ok('Route map appends S.mesh behind the Hail swaths chip', /\}\)\.concat\(S\.mesh \|\| \[\]\) : \[\]\);/.test(mission));
  ok('loadMesh runs on mount and on refresh', (mission.match(/loadMesh\(\);/g) || []).length >= 2);
  ok('it lazy-loads the module from its own path', mission.indexOf("'/pro/js/hail-mesh-swaths.js?v=1'") > 0);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
