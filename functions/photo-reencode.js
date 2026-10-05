/**
 * photo-reencode.js — the one server-side re-encode for photos the PUBLIC
 * sends us (website lead-form photos, homeowner portal uploads).
 *
 * Decoding and re-encoding with sharp does three jobs at once:
 *   - proves the bytes are a real image (anything else throws → refuse it);
 *   - drops ALL metadata, EXIF incl. GPS — sharp writes none unless asked
 *     (.withMetadata / .keepExif), and we never ask;
 *   - bakes the EXIF orientation into the pixels (.rotate() with no angle)
 *     BEFORE the orientation tag is dropped, so a phone photo doesn't come
 *     out sideways — and caps the long edge at MAX_EDGE.
 *
 * Extracted 2026-10-03 from public-lead-photos.js so the homeowner portal
 * upload (functions/portal.js uploadHomeownerPhoto) uses the identical
 * pipeline: SECURITY-CHECKLIST-2026-10-01 "Open" #2 — portal photos used to
 * be stored byte-for-byte as posted, EXIF/GPS and all.
 *
 * sharp is required lazily so modules that load this one still deploy/test
 * where sharp's prebuilt binary is absent (same pattern as image-pipeline.js).
 */
'use strict';

const MAX_EDGE = 2560;
const LIMIT_INPUT_PIXELS = 80e6;
const QUALITY = 85;

/**
 * Re-encode an uploaded photo. `format` picks the OUTPUT encoding:
 * 'jpeg' (default), 'png' or 'webp' — or the equivalent image/* MIME type,
 * so a caller can keep the format (and therefore the file extension /
 * contentType) the client declared. → Promise<Buffer>; rejects on a
 * payload that does not decode as an image.
 *
 * opts.maxEdge (optional, ≤ MAX_EDGE) caps the long edge lower — the deal
 * page's inspection photos (getDealPhoto, 2026-10-04) are served at 1600.
 */
async function reencodePhoto(buffer, format, opts) {
  const fmt = String(format || 'jpeg').replace(/^image\//, '');
  const want = Math.floor(Number(opts && opts.maxEdge));
  const edge = want > 0 ? Math.min(want, MAX_EDGE) : MAX_EDGE;
  const sharp = require('sharp');
  const p = sharp(buffer, { limitInputPixels: LIMIT_INPUT_PIXELS, failOn: 'error' })
    .rotate()
    .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true });
  if (fmt === 'png') return p.png({ compressionLevel: 9 }).toBuffer();
  if (fmt === 'webp') return p.webp({ quality: QUALITY }).toBuffer();
  return p.jpeg({ quality: QUALITY, mozjpeg: true }).toBuffer();
}

module.exports = { reencodePhoto, MAX_EDGE, LIMIT_INPUT_PIXELS, QUALITY };
