/**
 * functions/esign-stamp.js — burn field values into a PDF, permanently.
 *
 * The pure half of the envelope signing system: source PDF bytes + a field
 * layout + the signer's values in, a flattened PDF out. No Firebase, no
 * network, no I/O — so it can be tested exhaustively without an emulator,
 * which is the whole reason it is a separate file from esign-envelope.js.
 *
 * ─── COORDINATE SPACE, AND WHY IT IS NOT NORMALISED ────────────────────
 * Fields carry PDF USER-SPACE coordinates: points, origin BOTTOM-LEFT, the
 * space pdf-lib draws in natively.
 *
 * The obvious alternative — normalised 0..1 fractions of the rendered page —
 * looks tidier and is a trap. The browser renders through a pdf.js viewport
 * that has already applied the page's /Rotate and /CropBox, so a fraction of
 * the *rendered* page is not a fraction of the *PDF* page whenever a page is
 * rotated (scanned insurance forms and manufacturer warranties very often
 * are) or cropped. Reconstructing that mapping server-side means
 * re-deriving four rotation cases by hand and getting all four right.
 *
 * pdf.js already exposes the exact inverse as `viewport.convertToPdfPoint()`.
 * So the placement UI converts at capture time and stores real PDF points,
 * and this module draws them with no transform at all. Rotation, crop and
 * zoom stop being our problem, and a field placed at 400% zoom on a rotated
 * page lands in the same spot as one placed at 50% on an upright one.
 *
 * "Flattened" here means the values are drawn into the page content stream —
 * not added as AcroForm widgets. There is nothing left to un-fill, re-edit,
 * or render differently in another viewer.
 */

'use strict';

// Lazy + memoized: pdf-lib costs ~80ms to parse, and this module's exports
// are only ever reached from an actual sign/stamp call, never at cold-start
// module load — same memoized-require pattern already used for Stripe in
// stripe.js / handlers/stripe-connect.js / handlers/seats.js.
let _pdfLib = null;
function pdfLib() {
  if (!_pdfLib) _pdfLib = require('pdf-lib');
  return _pdfLib;
}

/** Field types a signer can be asked to complete. */
const FIELD_TYPES = ['signature', 'initials', 'date', 'text', 'checkbox'];

/** Ink colour for typed values and check marks — near-black, never pure. */
let _ink = null;
function INK() {
  if (!_ink) _ink = pdfLib().rgb(0.10, 0.10, 0.18);
  return _ink;
}

/**
 * Largest size at which `text` fits inside `w` x `h`, capped at `max`.
 * Returns a size >= 4 so a too-long value shrinks rather than vanishing;
 * callers clip to the box, so an overflowing value is visibly wrong instead
 * of silently absent.
 */
function fitFontSize(font, text, w, h, max) {
  let size = Math.min(max || 14, Math.max(4, h * 0.72));
  while (size > 4 && font.widthOfTextAtSize(text, size) > w) size -= 0.5;
  return size;
}

/**
 * Validate one field. Returns null when valid, else a reason string.
 * Exported (via validateFields) because BOTH the rep-side save and the
 * signer-side submit have to agree on what a legal field is, and a field
 * that passes save but fails submit would strand a signer mid-signing.
 */
function fieldError(f, pageCount) {
  if (!f || typeof f !== 'object') return 'not an object';
  if (typeof f.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(f.id)) return 'bad id';
  if (!FIELD_TYPES.includes(f.type)) return `unknown type ${f.type}`;
  if (!Number.isInteger(f.page) || f.page < 0 || f.page >= pageCount) return 'page out of range';
  for (const k of ['x', 'y', 'w', 'h']) {
    if (typeof f[k] !== 'number' || !Number.isFinite(f[k])) return `bad ${k}`;
  }
  if (f.w <= 0 || f.h <= 0) return 'zero-size box';
  // A field larger than any real page, or wildly off-page, is a placement
  // bug or a crafted payload; either way refuse it rather than draw it.
  if (f.w > 20000 || f.h > 20000) return 'box too large';
  if (f.x < -20000 || f.y < -20000 || f.x > 20000 || f.y > 20000) return 'origin off-page';
  if (f.role != null && (typeof f.role !== 'string' || f.role.length > 64)) return 'bad role';
  if (f.label != null && (typeof f.label !== 'string' || f.label.length > 200)) return 'bad label';
  return null;
}

/**
 * Validate a whole layout. Throws on the first problem, with the field id in
 * the message — a silent drop here would produce a document missing exactly
 * the signature somebody is relying on.
 */
function validateFields(fields, pageCount) {
  if (!Array.isArray(fields)) throw new Error('fields must be an array');
  if (fields.length > 200) throw new Error('too many fields (max 200)');
  const seen = new Set();
  for (const f of fields) {
    const err = fieldError(f, pageCount);
    if (err) throw new Error(`field ${(f && f.id) || '?'}: ${err}`);
    if (seen.has(f.id)) throw new Error(`duplicate field id ${f.id}`);
    seen.add(f.id);
  }
  return true;
}

/** Strip a data: URL prefix and decode. Returns a Buffer, or null. */
function decodePngDataUrl(s) {
  if (typeof s !== 'string') return null;
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(s.trim());
  if (!m) return null;
  try { return Buffer.from(m[1], 'base64'); } catch (_) { return null; }
}

/**
 * Draw `values` onto `pdfBytes` at the positions in `fields`.
 *
 * @param {Buffer|Uint8Array} pdfBytes  the ORIGINAL, unmodified source PDF
 * @param {Array}  fields               validated layout (PDF points)
 * @param {Object} values               fieldId -> { text?: string, png?: dataURL, checked?: bool }
 * @param {Object} [opts]
 * @param {string} [opts.certificateLine] a one-line audit stamp drawn in the
 *        bottom margin of every page. Omitted when falsy.
 * @returns {Promise<Uint8Array>} the flattened PDF
 */
async function stampPdf(pdfBytes, fields, values, opts) {
  const options = opts || {};
  const { PDFDocument, StandardFonts } = pdfLib();
  const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: false });
  const pages = pdf.getPages();
  validateFields(fields, pages.length);

  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const missingRequired = [];

  for (const f of fields) {
    const page = pages[f.page];
    const v = (values && values[f.id]) || null;
    const box = { x: f.x, y: f.y, w: f.w, h: f.h };

    // A field the signer left blank. Required-ness is enforced by the
    // caller too, but recording it here keeps the pure module honest when
    // it is used directly (tests, future batch signing).
    const empty =
      !v ||
      (f.type === 'checkbox' ? v.checked !== true
        : f.type === 'signature' || f.type === 'initials' ? !v.png
        : !(typeof v.text === 'string' && v.text.trim()));
    if (empty) {
      if (f.required) missingRequired.push(f.id);
      continue;
    }

    if (f.type === 'signature' || f.type === 'initials') {
      const buf = decodePngDataUrl(v.png);
      if (!buf) { if (f.required) missingRequired.push(f.id); continue; }
      const img = await pdf.embedPng(buf);
      // Preserve aspect ratio inside the box and centre it. A signature
      // stretched to a box's exact proportions looks forged.
      const scale = Math.min(box.w / img.width, box.h / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      page.drawImage(img, {
        x: box.x + (box.w - dw) / 2,
        y: box.y + (box.h - dh) / 2,
        width: dw,
        height: dh,
      });
      continue;
    }

    if (f.type === 'checkbox') {
      // Drawn, not a font glyph: Helvetica has no check mark, and WinAnsi
      // encoding throws on U+2713 rather than substituting.
      const s = Math.min(box.w, box.h);
      const cx = box.x + (box.w - s) / 2;
      const cy = box.y + (box.h - s) / 2;
      const t = Math.max(1, s * 0.12);
      page.drawLine({
        start: { x: cx + s * 0.18, y: cy + s * 0.52 },
        end: { x: cx + s * 0.42, y: cy + s * 0.24 },
        thickness: t, color: INK(),
      });
      page.drawLine({
        start: { x: cx + s * 0.42, y: cy + s * 0.24 },
        end: { x: cx + s * 0.84, y: cy + s * 0.78 },
        thickness: t, color: INK(),
      });
      continue;
    }

    // date / text — drawn as real text so it stays selectable and searchable.
    const text = String(v.text).trim();
    const font = f.type === 'date' ? helv : helv;
    const size = fitFontSize(font, text, box.w, box.h, f.fontSize);
    // Baseline sits a little above the box bottom so descenders stay inside.
    page.drawText(text, {
      x: box.x + 1,
      y: box.y + Math.max(1, (box.h - size) / 2 + size * 0.18),
      size,
      font,
      color: INK(),
      maxWidth: box.w,
    });
  }

  if (options.certificateLine) {
    const line = String(options.certificateLine).slice(0, 300);
    for (const page of pages) {
      const { width } = page.getSize();
      const size = 6;
      const w = helv.widthOfTextAtSize(line, size);
      page.drawText(line, {
        x: Math.max(4, (width - w) / 2),
        y: 6,
        size,
        font: helv,
        color: pdfLib().rgb(0.45, 0.45, 0.5),
      });
    }
  }

  // Deliberately NOT setting a producer/creator that claims more than we
  // know. Retain the source's own metadata.
  const out = await pdf.save({ useObjectStreams: true });
  return { bytes: out, missingRequired, pageCount: pages.length };
}

/** Page geometry the placement UI needs, without shipping the whole PDF twice. */
async function readPdfGeometry(pdfBytes) {
  const { PDFDocument } = pdfLib();
  const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: false });
  return pdf.getPages().map((p) => {
    const { width, height } = p.getSize();
    const rot = p.getRotation ? p.getRotation().angle : 0;
    return { w: width, h: height, rotation: ((rot % 360) + 360) % 360 };
  });
}

// The standard PDF fonts are WinAnsi: anything outside it (an emoji in a
// user agent, a curly quote in a name) would throw inside drawText and lose
// the whole certificate. Map the common typographic characters, drop the rest.
function winAnsiSafe(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-').replace(/ /g, ' ')
    .replace(/[^\x09\x0A\x0D\x20-\x7E¡-ÿ]/g, '');
}

function wrapLine(font, text, size, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const out = [];
  let line = '';
  for (const w of words) {
    const next = line ? line + ' ' + w : w;
    if (!line || font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
    out.push(line);
    line = w;
  }
  if (line) out.push(line);
  // A single unbroken token wider than the line (a SHA-256, a long UA
  // fragment) is hard-split so nothing runs off the page.
  const hard = [];
  for (const l of out.length ? out : ['']) {
    let rest = l;
    while (rest && font.widthOfTextAtSize(rest, size) > width) {
      let n = rest.length;
      while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > width) n--;
      hard.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    hard.push(rest);
  }
  return hard;
}

/**
 * Append the signature certificate (functions/esign-logic.js certificateLines)
 * as one or more US-Letter pages at the end of `pdfBytes`. Pure; returns the
 * new bytes and how many pages were added.
 *   lines: [{ h }, { h2 }, { t }, { sp }]  — heading, sub-heading, text, spacer
 */
async function appendAuditCertificate(pdfBytes, lines) {
  const { PDFDocument, StandardFonts, rgb } = pdfLib();
  const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: false });
  const before = pdf.getPageCount();
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 54;
  let page = pdf.addPage([W, H]);
  let y = H - M;
  const draw = (text, font, size, gapAfter) => {
    for (const ln of wrapLine(font, winAnsiSafe(text), size, W - 2 * M)) {
      if (y - size < M) { page = pdf.addPage([W, H]); y = H - M; }
      page.drawText(ln, { x: M, y: y - size, size, font, color: rgb(0.08, 0.09, 0.14) });
      y -= size * 1.4;
    }
    y -= gapAfter;
  };
  for (const l of Array.isArray(lines) ? lines : []) {
    if (!l) continue;
    if (l.h) draw(l.h, bold, 16, 8);
    else if (l.h2) draw(l.h2, bold, 11.5, 3);
    else if (l.sp) y -= 8;
    else if (l.t != null) draw(l.t, reg, 9.5, 2);
  }
  const bytes = await pdf.save({ useObjectStreams: true });
  return { bytes, pagesAdded: pdf.getPageCount() - before };
}

module.exports = {
  FIELD_TYPES,
  fieldError,
  validateFields,
  decodePngDataUrl,
  fitFontSize,
  stampPdf,
  readPdfGeometry,
  appendAuditCertificate,
  winAnsiSafe,
};
