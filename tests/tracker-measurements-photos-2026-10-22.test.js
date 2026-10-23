/**
 * tests/tracker-measurements-photos-2026-10-22.test.js
 *
 * Daily Success Horizon 2 item 4: body measurements + progress photos
 * (measurements-logic.js, photos-logic.js, measurements-ui.js). Synthetic data.
 * Photos stay on-device and carry no EXIF/GPS; nothing is uploaded.
 *
 * Run: node tests/tracker-measurements-photos-2026-10-22.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DS = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const M = require(path.join(DS, 'js', 'measurements-logic.js'));
const PH = require(path.join(DS, 'js', 'photos-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ok  ' + label); passed++; }
  else { console.log('  FAIL ' + label + (detail ? ' - ' + detail : '')); failed++; fails.push(label); }
}
const read = (...p) => fs.readFileSync(path.join(DS, ...p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) => s.replace(/^\/\*[\s\S]*?\*\//, '').replace(/^\s*\/\/.*$/gm, '');

console.log('\n1. units: one canonical number, no drift');
{
  ok('34.5 in is 876 mm', M.toMm(34.5, 'in') === 876);
  ok('87.6 cm is 876 mm', M.toMm('87.6', 'cm') === 876);
  ok('876 mm shows as 34.5 in and 87.6 cm', M.fromMm(876, 'in') === 34.5 && M.fromMm(876, 'cm') === 87.6);
  let mm = M.parseEntry('34.5', 'in'), drift = false;
  for (let i = 0; i < 20; i++) { const back = M.fromMm(mm, i % 2 ? 'cm' : 'in'); if (M.fromMm(mm, 'in') !== 34.5) drift = true; mm = M.parseEntry(String(M.fromMm(mm, 'in')), 'in'); void back; }
  ok('flipping the unit back and forth never changes the stored value', !drift && mm === 876);
  ok('a comma decimal (phone keyboards) parses', M.parseEntry('34,5', 'in') === 876);
  ok('format follows the unit', M.format(876, 'cm') === '87.6 cm' && M.format(876, 'in') === '34.5 in');
}

console.log('\n2. entry validation (negative controls)');
{
  const bad = ['', '   ', null, 'abc', '-5', '0', '1', '34.5.1', '34 in', '1e3', '9999', 'NaN', 'Infinity'];
  ok('blank, junk, zero, negative, tiny and absurd all rejected', bad.every((b) => M.parseEntry(b, 'in') === null), bad.filter((b) => M.parseEntry(b, 'in') !== null).join(','));
  ok('control: a normal waist is accepted', M.parseEntry('32', 'in') === 813);
  ok('control: a thin neck in cm is accepted', M.parseEntry('30', 'cm') === 300);
  ok('an unknown unit falls back to inches, never throws', M.parseEntry('32', 'furlongs') === 813);
}

console.log('\n3. the log: one value per site per day, bad rows dropped');
{
  let l = [];
  l = M.upsert(l, '2026-10-01', 'waist', 880);
  l = M.upsert(l, '2026-10-01', 'chest', 1100);
  l = M.upsert(l, '2026-10-01', 'waist', 870);
  ok('re-logging the same day replaces, does not duplicate', l.length === 2 && l.find((e) => e.site === 'waist').mm === 870);
  ok('bad site / date / value leave the list unchanged', M.upsert(l, '2026-10-01', 'elbow', 800).length === 2 && M.upsert(l, '10/1/26', 'waist', 800).length === 2 && M.upsert(l, '2026-10-02', 'waist', 5).length === 2);
  ok('garbage from storage is filtered', M.clean([{ date: 'x', site: 'waist', mm: 800 }, null, { date: '2026-10-01', site: 'waist', mm: 'a' }, { date: '2026-10-01', site: 'waist', mm: 800 }]).length === 1 && M.clean('nope').length === 0);
  ok('remove takes out only that site and day', M.remove(l, '2026-10-01', 'waist').length === 1);
  const unsorted = M.upsert(M.upsert([], '2026-10-05', 'waist', 860), '2026-09-01', 'waist', 900);
  ok('series is oldest first', M.series(unsorted, 'waist').map((e) => e.date).join() === '2026-09-01,2026-10-05');
}

console.log('\n4. the trend');
{
  ok('no data', M.trend([], 'waist').count === 0 && M.trend([], 'waist').change === null);
  const one = M.upsert([], '2026-10-01', 'waist', 880);
  ok('one point: a latest, no change', M.trend(one, 'waist').latest === 880 && M.trend(one, 'waist').change === null);
  let l = [];
  [['2026-08-01', 900], ['2026-09-01', 890], ['2026-09-20', 880], ['2026-10-01', 860]].forEach(([d, v]) => { l = M.upsert(l, d, 'waist', v); });
  const t = M.trend(l, 'waist');
  ok('change is measured against the reading nearest 4 weeks back (09-01 -> -30 mm)', t.change === -30 && t.since === '2026-09-01', JSON.stringify(t));
  const short = M.upsert(M.upsert([], '2026-09-28', 'chest', 1000), '2026-10-01', 'chest', 1010);
  ok('a short history compares against its oldest point', M.trend(short, 'chest').change === 10);
  ok('sites do not mix', M.trend(l, 'chest').count === 0);
  const svg = M.sparkline(M.series(l, 'waist'), 'Waist <b>&');
  ok('sparkline: polyline + dot, labelled, escaped', /polyline/.test(svg) && /role="img"/.test(svg) && /&lt;b&gt;&amp;/.test(svg) && !/NaN|Infinity/.test(svg));
  ok('one point is not a line', M.sparkline(M.series(one, 'waist')) === '');
  ok('a flat series does not divide by zero', !/NaN|Infinity/.test(M.sparkline([{ date: '2026-10-01', mm: 800 }, { date: '2026-10-08', mm: 800 }])));
}

console.log('\n5. photos: EXIF / GPS is stripped (positive + negative controls)');
{
  const seg = (marker, payload) => [0xFF, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255, ...payload];
  const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
  const gps = ascii('Exif\0\0GPSLatitude:39.1031N GPSLongitude:84.5120W');
  const jpeg = (extra) => Uint8Array.from([0xFF, 0xD8, ...seg(0xE0, ascii('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')), ...extra, ...seg(0xDB, [0, 8, 8, 8]), ...seg(0xC0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]), ...seg(0xDA, [1, 1, 0, 0, 0x3F, 0]), 0x12, 0x34, 0xFF, 0xD9]);
  const dirty = jpeg([...seg(0xE1, gps), ...seg(0xE1, ascii('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>')), ...seg(0xED, ascii('Photoshop 3.0')), ...seg(0xFE, ascii('shot at home'))]);
  const clean = jpeg([]);
  const text = (u) => Buffer.from(u).toString('latin1');
  ok('control: the dirty fixture really holds GPS, XMP and a comment', /GPSLatitude/.test(text(dirty)) && /xmpmeta/.test(text(dirty)) && /shot at home/.test(text(dirty)));
  ok('hasMetadata sees it', PH.hasMetadata(dirty) === true);
  const r = PH.stripJpegMetadata(dirty);
  ok('4 metadata segments removed', r && r.removed === 4, r && r.removed);
  ok('no GPS / XMP / comment / APP13 text survives', r && !/GPS|Exif|xmpmeta|shot at home|Photoshop/.test(text(r.out)));
  ok('the picture survives: JFIF, quant table, frame, scan data and EOI intact', r && r.out.length === clean.length && Buffer.compare(Buffer.from(r.out), Buffer.from(clean)) === 0);
  ok('control: an already-clean JPEG passes unchanged and is not flagged', PH.hasMetadata(clean) === false && PH.stripJpegMetadata(clean).removed === 0);
  ok('stripping twice is stable', PH.stripJpegMetadata(r.out).removed === 0);
  ok('not a JPEG -> null (refuse to store)', PH.stripJpegMetadata(Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4])) === null && PH.stripJpegMetadata(null) === null);
  ok('truncated segment -> null, no crash', PH.stripJpegMetadata(dirty.subarray(0, 30)) === null);
  ok('metadata after a bogus length -> null', PH.stripJpegMetadata(Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE1, 0xFF, 0xFF, 0, 0])) === null);
}

console.log('\n6. photos: sizes, records, compare, cap');
{
  ok('a 4032x3024 shot fits 1280 on the long edge', JSON.stringify(PH.fitSize(4032, 3024)) === '{"w":1280,"h":960}');
  ok('a small image is never enlarged', JSON.stringify(PH.fitSize(600, 800)) === '{"w":600,"h":800}');
  ok('zero / NaN size -> null', PH.fitSize(0, 10) === null && PH.fitSize(NaN, 10) === null);
  const rec = PH.makeRecord({ date: '2026-10-22', pose: 'front', w: 960, h: 1280, bytes: 90000, blob: {} });
  ok('record carries the photo and its labels only (no url / token / path)', rec && Object.keys(rec).sort().join() === 'blob,bytes,date,h,id,pose,w');
  ok('bad pose / date / missing blob -> no record', PH.makeRecord({ date: '2026-10-22', pose: 'selfie', blob: {} }) === null && PH.makeRecord({ date: 'x', pose: 'front', blob: {} }) === null && PH.makeRecord({ date: '2026-10-22', pose: 'front' }) === null);
  const mk = (id, date, pose) => ({ id, date, pose });
  const list = [mk('a', '2026-09-01', 'front'), mk('b', '2026-10-20', 'front'), mk('c', '2026-10-01', 'front'), mk('d', '2026-10-02', 'side')];
  const fl = PH.firstAndLatest(list, 'front');
  ok('compare pairs oldest and newest of the SAME pose', fl && fl.first.id === 'a' && fl.latest.id === 'b');
  ok('one photo of a pose has nothing to compare', PH.firstAndLatest(list, 'side') === null && PH.firstAndLatest(list, 'back') === null);
  const many = Array.from({ length: 65 }, (_, i) => mk('p' + i, '2026-01-' + String((i % 28) + 1).padStart(2, '0'), 'front'));
  ok('cap drops only the overflow, oldest first', PH.prune(many).length === 5 && PH.prune(many.slice(0, 60)).length === 0);
}

console.log('\n7. wired in safely, and nothing leaves the device');
{
  const html = read('index.html');
  const at = (s) => html.indexOf(s);
  ok('logic loads before the ui, all deferred external scripts',
    /<script src="\/pro\/daily-success\/js\/measurements-logic\.js\?v=\d+" defer><\/script>/.test(html) &&
    /<script src="\/pro\/daily-success\/js\/photos-logic\.js\?v=\d+" defer><\/script>/.test(html) &&
    /<script src="\/pro\/daily-success\/js\/measurements-ui\.js\?v=\d+" defer><\/script>/.test(html) &&
    at('measurements-logic.js') < at('measurements-ui.js') && at('photos-logic.js') < at('measurements-ui.js'));
  ok('the ui loads BEFORE progress-charts-ui so the Progress card stays on top', at('measurements-ui.js') < at('progress-charts-ui.js') && at('measurements-ui.js') > at('tracker-history-ui.js'));
  ok('stylesheet linked', /css\/measurements\.css\?v=\d+/.test(html));
  const ui = stripComments(read('js', 'measurements-ui.js'));
  const logic = stripComments(read('js', 'measurements-logic.js') + read('js', 'photos-logic.js'));
  ok('no inline handlers or eval', !/\bon[a-z]+\s*=\s*["']/.test(ui) && !/\beval\(|new Function/.test(ui));
  ok('control: the same scan does catch an upload (so the next check can fail)', /fetch\(/.test('fetch(url)') && /XMLHttpRequest/.test('new XMLHttpRequest()'));
  ok('no network, Storage, Firebase or token anywhere in the feature', !/fetch\(|XMLHttpRequest|sendBeacon|firebase|storage\.googleapis|getDownloadURL|uploadBytes|\?token=|alt=media|WebSocket/i.test(ui + logic));
  ok('photo blobs are shown only through blob: URLs that are revoked on re-render', /createObjectURL/.test(ui) && /revokeObjectURL/.test(ui));
  ok('every photo is re-encoded through a canvas AND run through the strip before it is stored', /toBlob/.test(ui) && /stripJpegMetadata/.test(ui) && ui.indexOf('stripJpegMetadata') < ui.indexOf('putPhoto(rec)'));
  ok('a failed strip refuses the photo (throws, no fallback store)', /if \(!stripped\) throw/.test(ui));
  ok('user-visible values are escaped into innerHTML', /esc\(p\.date\)/.test(ui) && /esc\(l\.exId\)|esc\(s\.id\)/.test(ui) && /esc\(t\.since\)/.test(ui));
  ok('delete needs a second tap (no confirm() dialog)', /Tap again to delete/.test(ui) && !/\bconfirm\(/.test(ui));
  ok('it re-wraps the earlier hooks without dropping their flags', /Object\.keys\(origFit\)\.forEach/.test(ui) && /Object\.keys\(origDash\)\.forEach/.test(ui));
  const css = read('css', 'measurements.css');
  ok('inputs and buttons are 44px tap targets, input is 16px (no iOS zoom)', /\.ms-in \{[^}]*min-height: 44px[^}]*font-size: 16px/.test(css) && /\.ms-save, \.ms-add \{[^}]*min-height: 44px/.test(css));
  ok('colours come from theme tokens, not fixed hex', !/#[0-9a-fA-F]{3,6}\b(?![^{]*var\()/.test(css.replace(/var\([^)]*\)/g, '')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
