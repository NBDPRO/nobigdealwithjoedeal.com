/**
 * photo-exif.js — a photo's own date and GPS, for every upload path
 * (2026-11-09, CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09 §1 step 3).
 *
 * Before this, only the customer page read EXIF (photo-smart-ingest.js) and
 * it kept the result under `exif` only: `capturedAt` was the device clock at
 * upload (PhotoEngine) or absent (customer page, dashboard modal), and
 * `geoLocation` came only from a camera session's GPS fix. A photo picked
 * from the camera roll a week after the job read as taken on upload day.
 *
 * photoExifFields(file, deviceMs) returns the fields an upload merges into
 * its /photos doc:
 *   capturedAt        epoch ms (a NUMBER, as every reader already expects):
 *                     EXIF DateTimeOriginal (else CreateDate) when present and
 *                     plausible, else `deviceMs`, the device clock the caller
 *                     used before.
 *   capturedAtSource  'exif' | 'device'.
 *   deviceCapturedAt  with an EXIF date only: the device clock (`deviceMs`).
 *   geoLocation       only when the file carries GPS: {lat, lng, accuracy: null,
 *                     at, source: 'exif'} — the camera session fix's shape.
 * It never throws and never rejects: any failure is the device-clock answer.
 *
 * Weight: an ES module loaded with import() at upload time by its callers
 * (photo-engine.js, customer-bootstrap.module.js, dashboard-bootstrap.module.js),
 * so no boot file carries it. The vendored exifr (75 KB, also used by
 * photo-smart-ingest.js) loads only for a file that has EXIF to read: a JPEG
 * whose head has no Exif segment (every canvas capture from the in-app
 * camera) is answered without it.
 */

const EXIFR_URL = '/assets/vendor/exifr/exifr.esm.mjs';
const HEAD_BYTES = 256 * 1024;        // a JPEG's APP1 Exif segment sits in the first 64 KB
const READ_TIMEOUT_MS = 4000;         // a slow exifr fetch must not hold an upload
const MIN_PLAUSIBLE_MS = Date.UTC(2005, 0, 1);   // an unset camera clock reads 2000-01-01 or 1970
const FUTURE_SLACK_MS = 36 * 3600 * 1000;        // EXIF has no time zone; allow a day and a half

const PICK = ['DateTimeOriginal', 'CreateDate', 'GPSLatitude', 'GPSLatitudeRef',
  'GPSLongitude', 'GPSLongitudeRef', 'latitude', 'longitude'];

let _libPromise = null;
function _defaultLoadExifr() {
  if (!_libPromise) {
    _libPromise = import(EXIFR_URL).catch((e) => { _libPromise = null; throw e; });
  }
  return _libPromise;
}

/**
 * Does this file head say JPEG-with-Exif? Pure.
 * @param {DataView} view the first bytes of the file
 * @returns {true|false|null} true: a JPEG with an APP1 Exif segment; false: a
 *   JPEG without one; null: not a JPEG (HEIC, PNG, …: exifr decides).
 */
export function jpegHasExif(view) {
  if (!view || view.byteLength < 4 || view.getUint16(0) !== 0xFFD8) return null;
  let pos = 2;
  while (pos + 4 <= view.byteLength) {
    if (view.getUint8(pos) !== 0xFF) return false;
    const marker = view.getUint16(pos);
    if (marker === 0xFFDA || marker === 0xFFD9) return false;      // image data / end: no more metadata
    const size = view.getUint16(pos + 2);
    if (marker === 0xFFE1 && pos + 10 <= view.byteLength
      && view.getUint32(pos + 4) === 0x45786966 && view.getUint16(pos + 8) === 0) return true;
    if (size < 2) return false;
    pos += 2 + size;
  }
  return false;
}

function _ms(v) {
  if (v && typeof v.getTime === 'function') { const t = v.getTime(); return isFinite(t) ? t : 0; }
  return 0;
}

function _latLng(raw) {
  if (!raw) return null;
  const lat = Number(raw.latitude), lng = Number(raw.longitude);
  if (raw.latitude == null || raw.longitude == null || !isFinite(lat) || !isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
  return { lat, lng };
}

/**
 * exifr's output (or null) → the /photos fields. Pure.
 * @param {Object|null} raw  { DateTimeOriginal?: Date, CreateDate?: Date, latitude?, longitude? }
 * @param {number} deviceMs  the device clock the caller would have written
 */
export function exifToPhotoFields(raw, deviceMs) {
  const device = (typeof deviceMs === 'number' && isFinite(deviceMs)) ? deviceMs : Date.now();
  const taken = _ms(raw && raw.DateTimeOriginal) || _ms(raw && raw.CreateDate);
  const plausible = taken >= MIN_PLAUSIBLE_MS && taken <= device + FUTURE_SLACK_MS;
  // deviceCapturedAt keeps the device clock beside an EXIF date: a photo just
  // pushed into a local cache has no resolved createdAt yet, and
  // customer-photo-hub.js orders it by this upload-time moment until re-read.
  const out = plausible
    ? { capturedAt: taken, capturedAtSource: 'exif', deviceCapturedAt: device }
    : { capturedAt: device, capturedAtSource: 'device' };
  const g = _latLng(raw);
  if (g) out.geoLocation = { lat: g.lat, lng: g.lng, accuracy: null, at: plausible ? taken : null, source: 'exif' };
  return out;
}

/**
 * The raw EXIF date/GPS of a File/Blob, or null. Never rejects.
 * @param {Blob} file
 * @param {{loadExifr?: function(): Promise}} [opts] loadExifr: tests inject the library
 */
export async function readPhotoExif(file, opts) {
  try {
    if (!file || typeof file.slice !== 'function') return null;
    const head = await file.slice(0, HEAD_BYTES).arrayBuffer();
    const isJpegExif = jpegHasExif(new DataView(head));
    if (isJpegExif === false) return null;                         // a JPEG with nothing to read
    const lib = await ((opts && opts.loadExifr) || _defaultLoadExifr)();
    const parse = lib && (lib.parse || (lib.default && lib.default.parse));
    if (typeof parse !== 'function') return null;
    // A JPEG's head holds its Exif segment; anything else goes to exifr whole
    // (it reads a Blob in chunks).
    const raw = await parse.call(lib.default || lib, isJpegExif ? head : file, { gps: true, pick: PICK });
    return raw || null;
  } catch (e) {
    return null;
  }
}

/**
 * The fields an upload merges into its /photos doc. Never rejects; on any
 * failure (or a slow read) the answer is the device clock.
 * @param {Blob} file
 * @param {number} deviceMs
 * @param {{loadExifr?: function(): Promise, timeoutMs?: number}} [opts]
 */
export async function photoExifFields(file, deviceMs, opts) {
  const ms = (opts && opts.timeoutMs) || READ_TIMEOUT_MS;
  let timer = null;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  const raw = await Promise.race([readPhotoExif(file, opts), late]);
  clearTimeout(timer);
  return exifToPhotoFields(raw, deviceMs);
}
