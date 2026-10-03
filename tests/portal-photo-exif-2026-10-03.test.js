/**
 * tests/portal-photo-exif-2026-10-03.test.js
 *
 * SECURITY-CHECKLIST-2026-10-01 "Open" #2: photos a homeowner uploaded
 * through the customer portal (functions/portal.js uploadHomeownerPhoto)
 * were stored byte-for-byte as posted — EXIF, including the GPS position of
 * the homeowner's house, survived into Storage, and nothing proved the bytes
 * were an image at all. The website lead-form photo path already decoded and
 * re-encoded with sharp.
 *
 * Fix: that re-encode now lives in functions/photo-reencode.js
 * (reencodePhoto) and BOTH upload paths call it. The portal keeps the
 * declared format (jpeg/png/webp), so storage path, contentType, mimeType
 * and the response shape are unchanged.
 *
 *   1. reencodePhoto, real sharp: a JPEG carrying GPS EXIF comes out with no
 *      EXIF; orientation is baked into the pixels; size cap; format kept;
 *      non-images refused.
 *   2. portal.js wiring: the bytes saved to Storage are the re-encoded ones,
 *      decoded BEFORE the quota slot is reserved; no raw passthrough left.
 *   3. public-lead-photos.js still goes through the same helper.
 *
 * Needs functions/ deps (sharp). Run: node tests/portal-photo-exif-2026-10-03.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const fnRequire = createRequire(path.join(FN, 'package.json'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

(async () => {
  const sharp = fnRequire('sharp');
  const { reencodePhoto } = require(path.join(FN, 'photo-reencode.js'));

  const GPS_EXIF = {
    IFD0: { Make: 'ZZ_QA Camera', Model: 'Portal QA' },
    IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '39/1 6/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '84/1 30/1 0/1' },
  };
  const make = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 120, g: 90, b: 60 } } });

  console.log('\n1. reencodePhoto — real sharp');
  {
    const withGps = await make(1200, 900).jpeg().withExif(GPS_EXIF).toBuffer();
    const before = await sharp(withGps).metadata();
    ok('fixture: the source JPEG really carries EXIF (positive control)', !!before.exif && before.exif.length > 20, 'exif bytes: ' + (before.exif ? before.exif.length : 0));
    ok('fixture: the EXIF block holds the tags written with the GPS IFD', !!before.exif && before.exif.includes(Buffer.from('ZZ_QA Camera')) && before.exif.length > 100);

    const out = await reencodePhoto(withGps, 'image/jpeg');
    const after = await sharp(out).metadata();
    ok('output has NO EXIF (GPS gone)', !after.exif, 'exif bytes: ' + (after.exif ? after.exif.length : 0));
    ok('output carries no XMP / IPTC either', !after.xmp && !after.iptc);
    ok('output does not contain the camera tag bytes anywhere', !out.includes(Buffer.from('ZZ_QA Camera')));
    ok('output is still a valid JPEG of the same size', after.format === 'jpeg' && after.width === 1200 && after.height === 900, after.format + ' ' + after.width + 'x' + after.height);

    // Orientation: a 400x200 stored image tagged "rotate 90° CW" (6) must be
    // baked to 200x400 pixels — dropping the tag without rotating would turn
    // every portrait phone photo sideways.
    const rotated = await make(400, 200).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    ok('fixture: orientation tag 6 present', (await sharp(rotated).metadata()).orientation === 6);
    const rOut = await sharp(await reencodePhoto(rotated, 'image/jpeg')).metadata();
    ok('EXIF orientation is baked into the pixels, tag dropped', rOut.width === 200 && rOut.height === 400 && !rOut.orientation, rOut.width + 'x' + rOut.height + ' o=' + rOut.orientation);

    const big = await sharp(await reencodePhoto(await make(4000, 3000).jpeg().toBuffer(), 'image/jpeg')).metadata();
    ok('long edge capped at 2560px, aspect kept', big.width === 2560 && big.height === 1920, big.width + 'x' + big.height);

    const pngGps = await make(300, 200).png().withExif(GPS_EXIF).toBuffer();
    ok('fixture: the PNG really carries EXIF', !!(await sharp(pngGps).metadata()).exif);
    const pngOut = await reencodePhoto(pngGps, 'image/png');
    const pngMeta = await sharp(pngOut).metadata();
    ok('PNG stays PNG (declared format → unchanged path ext / contentType) and loses EXIF', pngMeta.format === 'png' && !pngMeta.exif, pngMeta.format + ' exif=' + !!pngMeta.exif);
    const webpGps = await make(300, 200).webp().withExif(GPS_EXIF).toBuffer();
    ok('fixture: the WebP really carries EXIF', !!(await sharp(webpGps).metadata()).exif);
    const webpMeta = await sharp(await reencodePhoto(webpGps, 'image/webp')).metadata();
    ok('WebP stays WebP and loses EXIF', webpMeta.format === 'webp' && !webpMeta.exif);

    let threw = false;
    try { await reencodePhoto(Buffer.from('<html>not an image</html>'), 'image/jpeg'); } catch (_) { threw = true; }
    ok('a non-image payload is refused (decode throws)', threw);
  }

  console.log('\n2. portal.js uploadHomeownerPhoto wiring');
  {
    const src = strip(read('functions/portal.js'));
    const start = src.indexOf('exports.uploadHomeownerPhoto');
    const end = src.indexOf('exports.requestCallback');
    ok('endpoint boundaries found', start > 0 && end > start);
    const body = src.slice(start, end);
    ok('portal.js imports the shared re-encode helper', /const \{ reencodePhoto \} = require\('\.\/photo-reencode'\);/.test(src));
    ok('the decoded upload goes through reencodePhoto with the declared format',
      /buffer = await reencodePhoto\(Buffer\.from\(b64, 'base64'\), mimeType\);/.test(body));
    ok('no raw base64 passthrough remains (Buffer.from(b64) only feeds the re-encode)',
      (body.match(/Buffer\.from\(b64/g) || []).length === 1 && !/buffer\s*=\s*Buffer\.from\(b64/.test(body));
    ok('Storage receives the re-encoded buffer', /await file\.save\(buffer, \{ contentType: mimeType, resumable: false \}\);/.test(body));
    const iDec = body.indexOf('reencodePhoto('), iTx = body.indexOf('db.runTransaction(');
    ok('decode happens BEFORE the quota slot is reserved (a bad file never burns one of the ten)', iDec > 0 && iTx > iDec, iDec + ',' + iTx);
    ok('an undecodable file is a 400, not a 500', /catch \(decodeErr\)[\s\S]{0,200}res\.status\(400\)/.test(body));
    ok('storage path shape is unchanged', body.includes('const path = `homeowner-uploads/${tok.ownerUid}/${tok.leadId}/${ts}.${ext}`;'));
    ok('response shape is unchanged', /res\.status\(200\)\.json\(\{\s*ok: true,\s*photoId: photoRef\.id,\s*url,\s*remainingToday:/.test(body));
    ok('memory budget fits a sharp decode (1GiB, like uploadPublicLeadPhoto)', /memory: '1GiB'/.test(body));
  }

  console.log('\n3. public lead-form photos share the helper');
  {
    const src = strip(read('functions/public-lead-photos.js'));
    ok('public-lead-photos.js reencode() delegates to reencodePhoto', /require\('\.\/photo-reencode'\)/.test(src) && /return reencodePhoto\(buffer, 'jpeg'\)/.test(src));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('Failures:\n - ' + fails.join('\n - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
