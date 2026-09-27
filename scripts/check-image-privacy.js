#!/usr/bin/env node
/**
 * check-image-privacy.js — CI gate for the EXIF/GPS-strip invariant.
 *
 * The rule (CLAUDE.md + runbooks/PUBLISH-PROJECT.md): photos ship to the
 * public site as EXIF-stripped copies. Originals are phone/CRM shots whose
 * EXIF pinpoints a CUSTOMER'S PROPERTY via GPS. prepare-project-images.mjs
 * strips on re-encode — but nothing verified the committed bytes, and on
 * 2026-08-10 three published gallery JPEGs were found carrying GPS IFDs
 * (two with full lat/lon values). This gate makes that class un-shippable.
 *
 * Policy:
 *   FAIL — any JPEG under docs/ whose EXIF contains a GPS IFD (tag 0x8825)
 *   FAIL — any JPEG under docs/assets/images/projects/ with ANY APP1
 *          metadata (EXIF or XMP): that dir is pipeline-owned, and the
 *          pipeline emits none
 *   FAIL — any WebP under docs/ with an EXIF or XMP chunk
 *   FAIL — any AVIF under docs/ with an Exif item or an XMP item
 *          (mime application/rdf+xml) in its meta box. Added 2026-09-27
 *          when the site began shipping AVIF siblings (perf/modern-images):
 *          before that, .avif files were not scanned at all. The GPS IFD
 *          is named in the message when the Exif payload carries one.
 *   PASS — camera EXIF without GPS outside the projects dir (e.g. the
 *          lumanail product-pack shots) — benign, deliberate, listed only
 *          with --verbose
 *
 * --fix  losslessly strips APP1 segments from offending JPEGs (and EXIF/XMP
 *        chunks from offending WebPs) IN PLACE — pure byte surgery, pixel
 *        data untouched, no re-encode, no quality loss. Safe only when the
 *        EXIF orientation tag is absent or 1 (normal); --fix refuses
 *        otherwise so a rotated photo can't silently flip on the site
 *        (run those through prepare-project-images.mjs instead).
 *        AVIF is never auto-fixed: removing an item means rewriting the
 *        iloc offsets, so re-encode with sharp (which strips by default).
 *
 * --dir <path>  scan <path> instead of docs/ (to prove the gate against
 *        fixtures; the projects-dir rule still keys on docs/).
 *
 * Zero dependencies. Usage:
 *   node scripts/check-image-privacy.js [--fix] [--verbose] [--dir <path>]
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(REPO_ROOT, 'docs');
const PROJECTS_DIR = path.join(DOCS, 'assets', 'images', 'projects');

const FIX = process.argv.includes('--fix');
const VERBOSE = process.argv.includes('--verbose');
const DIR_ARG = process.argv.indexOf('--dir');
const SCAN_ROOT = DIR_ARG > 0 && process.argv[DIR_ARG + 1] ? path.resolve(process.argv[DIR_ARG + 1]) : DOCS;

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// ── JPEG: iterate markers; report APP1 segments + GPS IFD + orientation. ──
function inspectJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const app1 = []; // {start, len (incl marker+size bytes), isExif, hasGps, orientation}
  let i = 2;
  while (i < buf.length - 4) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xda) break; // start of scan — metadata lives before it
    const segLen = buf.readUInt16BE(i + 2);
    if (marker === 0xe1) {
      const seg = buf.subarray(i + 4, i + 2 + segLen);
      const isExif = seg.subarray(0, 6).equals(Buffer.from('Exif\0\0'));
      let hasGps = false, orientation = null;
      if (isExif && seg.length > 14) {
        const tiff = seg.subarray(6);
        const le = tiff[0] === 0x49; // 'II' little-endian
        const rd16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
        const rd32 = (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
        try {
          const ifd = rd32(4);
          const n = rd16(ifd);
          for (let k = 0; k < n; k++) {
            const e = ifd + 2 + k * 12;
            const tag = rd16(e);
            if (tag === 0x8825) hasGps = true;
            if (tag === 0x0112) orientation = rd16(e + 8);
          }
        } catch (_) { /* truncated TIFF — treat as metadata present, no GPS proof */ }
      }
      app1.push({ start: i, len: 2 + segLen, isExif, hasGps, orientation });
    }
    i += 2 + segLen;
  }
  return app1;
}

function stripJpegApp1(buf, app1) {
  const parts = [];
  let pos = 0;
  for (const seg of app1) {
    parts.push(buf.subarray(pos, seg.start));
    pos = seg.start + seg.len;
  }
  parts.push(buf.subarray(pos));
  return Buffer.concat(parts);
}

// ── WebP: RIFF chunk walk; EXIF/XMP chunks are metadata. ──
function inspectWebp(buf) {
  if (buf.length < 16 || buf.subarray(0, 4).toString() !== 'RIFF' || buf.subarray(8, 12).toString() !== 'WEBP') return null;
  const meta = []; // {start, len (incl header+pad)}
  let i = 12;
  while (i < buf.length - 8) {
    const id = buf.subarray(i, i + 4).toString('latin1');
    const sz = buf.readUInt32LE(i + 4);
    const total = 8 + sz + (sz & 1);
    if (id === 'EXIF' || id === 'XMP ') meta.push({ start: i, len: total, id: id.trim() });
    i += total;
  }
  return meta;
}

function stripWebpChunks(buf, meta) {
  const parts = [];
  let pos = 0;
  for (const c of meta) {
    parts.push(buf.subarray(pos, c.start));
    pos = c.start + c.len;
  }
  parts.push(buf.subarray(pos));
  const out = Buffer.concat(parts);
  out.writeUInt32LE(out.length - 8, 4); // RIFF size = file minus 8-byte header
  return out;
}

// ── TIFF (EXIF body): does IFD0 point at a GPS IFD (tag 0x8825)? ──
function tiffHasGps(tiff) {
  if (tiff.length < 8) return false;
  const le = tiff[0] === 0x49;
  if (!le && tiff[0] !== 0x4d) return false;
  const rd16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const rd32 = (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  try {
    const ifd = rd32(4);
    const n = rd16(ifd);
    for (let k = 0; k < n; k++) if (rd16(ifd + 2 + k * 12) === 0x8825) return true;
  } catch (_) { /* truncated — no GPS proof */ }
  return false;
}

// ── AVIF (ISOBMFF/HEIF): walk ftyp → meta → iinf/iloc. Metadata lives in
//    items: item_type 'Exif', or 'mime' with content_type application/rdf+xml
//    (XMP). Returns null if not AVIF, else [{ id, what, hasGps }]. ──
function inspectAvif(buf) {
  const boxes = (start, end) => {
    const out = [];
    let i = start;
    while (i + 8 <= end) {
      let size = buf.readUInt32BE(i);
      const type = buf.subarray(i + 4, i + 8).toString('latin1');
      let hdr = 8;
      if (size === 1) { size = Number(buf.readBigUInt64BE(i + 8)); hdr = 16; }
      else if (size === 0) size = end - i;
      if (size < hdr || i + size > end) break;
      out.push({ type, start: i, body: i + hdr, end: i + size });
      i += size;
    }
    return out;
  };
  const top = boxes(0, buf.length);
  if (!top.length || top[0].type !== 'ftyp') return null;
  const brands = buf.subarray(top[0].body, top[0].end).toString('latin1');
  if (!/avi[fs]/.test(brands)) return null;
  const meta = top.find((b) => b.type === 'meta');
  if (!meta) return [];
  const kids = boxes(meta.body + 4, meta.end); // meta is a FullBox
  const found = [];
  const iinf = kids.find((b) => b.type === 'iinf');
  if (iinf) {
    const v = buf[iinf.body];
    const first = iinf.body + 4 + (v === 0 ? 2 : 4);
    for (const infe of boxes(first, iinf.end).filter((b) => b.type === 'infe')) {
      const iv = buf[infe.body];
      if (iv < 2) continue;
      let p = infe.body + 4;
      const id = iv === 2 ? buf.readUInt16BE(p) : buf.readUInt32BE(p);
      p += (iv === 2 ? 2 : 4) + 2; // item_ID, item_protection_index
      const itype = buf.subarray(p, p + 4).toString('latin1');
      p += 4;
      if (itype === 'Exif') found.push({ id, what: 'Exif' });
      if (itype === 'mime') {
        const nameEnd = buf.indexOf(0, p); // item_name is NUL-terminated, then content_type
        const ctEnd = buf.indexOf(0, nameEnd + 1);
        const ct = buf.subarray(nameEnd + 1, ctEnd > 0 && ctEnd < infe.end ? ctEnd : infe.end).toString('latin1');
        if (/rdf\+xml/i.test(ct)) found.push({ id, what: 'XMP' });
      }
    }
  }
  // Locate each Exif item's bytes via iloc (construction_method 0 = file
  // offsets) so the message can say whether it carries a GPS IFD.
  const iloc = kids.find((b) => b.type === 'iloc');
  if (iloc && found.some((f) => f.what === 'Exif')) {
    try {
      const v = buf[iloc.body];
      let p = iloc.body + 4;
      const offSz = buf[p] >> 4, lenSz = buf[p] & 15, baseSz = buf[p + 1] >> 4, idxSz = v >= 1 ? buf[p + 1] & 15 : 0;
      p += 2;
      const rdN = (n) => { let x = 0; for (let k = 0; k < n; k++) x = x * 256 + buf[p + k]; p += n; return x; };
      const count = v < 2 ? rdN(2) : rdN(4);
      for (let c = 0; c < count; c++) {
        const id = v < 2 ? rdN(2) : rdN(4);
        const method = v >= 1 ? rdN(2) & 15 : 0;
        rdN(2); // data_reference_index
        const base = rdN(baseSz);
        const extents = rdN(2);
        const parts = [];
        for (let e = 0; e < extents; e++) {
          if (idxSz) rdN(idxSz);
          const off = rdN(offSz), len = rdN(lenSz);
          if (method === 0) parts.push(buf.subarray(base + off, base + off + len));
        }
        const item = found.find((f) => f.id === id && f.what === 'Exif');
        if (item && parts.length) {
          const data = Buffer.concat(parts);
          const tiffAt = 4 + data.readUInt32BE(0); // exif_tiff_header_offset
          item.hasGps = tiffHasGps(data.subarray(tiffAt));
        }
      }
    } catch (_) { /* malformed iloc — the Exif item alone already fails */ }
  }
  return found;
}

const failures = [];
const benign = [];
let fixed = 0, scanned = 0;

for (const file of walk(SCAN_ROOT)) {
  const ext = path.extname(file).toLowerCase();
  const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
  const inProjects = file.startsWith(PROJECTS_DIR + path.sep);

  if (ext === '.jpg' || ext === '.jpeg') {
    scanned++;
    const buf = fs.readFileSync(file);
    const app1 = inspectJpeg(buf);
    if (!app1 || !app1.length) continue;
    const hasGps = app1.some((s) => s.hasGps);
    const bad = hasGps || inProjects;
    if (!bad) { benign.push(rel); continue; }
    const why = hasGps ? 'EXIF GPS IFD (customer-property location!)' : 'APP1 metadata in the pipeline-owned projects dir';
    if (FIX) {
      const rotated = app1.some((s) => s.orientation != null && s.orientation !== 1);
      if (rotated) {
        failures.push(`${rel}: ${why} — NOT auto-fixed: EXIF orientation != 1; re-run through prepare-project-images.mjs`);
        continue;
      }
      fs.writeFileSync(file, stripJpegApp1(buf, app1));
      fixed++;
      console.log(`fixed: ${rel} — stripped ${app1.length} APP1 segment(s) (${why})`);
    } else {
      failures.push(`${rel}: ${why}`);
    }
  } else if (ext === '.webp') {
    scanned++;
    const buf = fs.readFileSync(file);
    const meta = inspectWebp(buf);
    if (!meta || !meta.length) continue;
    const why = 'WebP ' + meta.map((c) => c.id).join('+') + ' metadata chunk(s)';
    if (FIX) {
      fs.writeFileSync(file, stripWebpChunks(buf, meta));
      fixed++;
      console.log(`fixed: ${rel} — stripped ${why}`);
    } else {
      failures.push(`${rel}: ${why}`);
    }
  } else if (ext === '.avif') {
    scanned++;
    const meta = inspectAvif(fs.readFileSync(file));
    if (meta === null) { failures.push(`${rel}: .avif that does not parse as AVIF (ftyp avif/avis missing)`); continue; }
    if (!meta.length) continue;
    const gps = meta.some((m) => m.hasGps);
    const why = `AVIF ${meta.map((m) => m.what).join('+')} metadata item(s)${gps ? ' with an EXIF GPS IFD (customer-property location!)' : ''}`;
    failures.push(`${rel}: ${why}${FIX ? ' — NOT auto-fixed: re-encode with sharp (strips metadata by default)' : ''}`);
  }
}

if (VERBOSE && benign.length) {
  console.log(`benign camera EXIF (no GPS, outside projects dir) — accepted:\n  ${benign.join('\n  ')}`);
}

if (failures.length) {
  for (const f of failures) console.error(`✗ ${f}`);
  console.error(`
Published images must carry no location metadata (CLAUDE.md invariant;
runbooks/PUBLISH-PROJECT.md). Fix with:
  node scripts/check-image-privacy.js --fix        (lossless strip in place)
or re-encode originals via scripts/prepare-project-images.mjs.`);
  process.exit(1);
}
console.log(`check-image-privacy: ${scanned} image(s) scanned — ${FIX ? `${fixed} fixed, ` : ''}0 privacy failures${benign.length ? ` (${benign.length} benign camera-EXIF accepted)` : ''}.`);
