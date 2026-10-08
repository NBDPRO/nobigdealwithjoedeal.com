/**
 * esign-autodetect.js — propose signature fields from a PDF's own text layer.
 *
 * The point of the whole exercise. A rep should not have to hand-place a box
 * on every "Signature ____" line of a six-page insurance form, and a
 * homeowner should never be told to "drag your info roughly where it goes".
 * pdf.js hands us every text run with its position, so the form tells us
 * where its own fields are — we propose, the rep adjusts.
 *
 * Deliberately a PURE function over text items so it can be unit-tested in
 * Node without a browser or a PDF. The browser half just feeds it
 * `page.getTextContent().items` and draws the result.
 *
 * Coordinates in AND out are PDF user space (points, origin bottom-left) —
 * the same space functions/esign-stamp.js draws in. See that file for why.
 *
 * TWO SIGNALS, in priority order:
 *
 *  1. A RULED LINE — a run of underscores ("________") or a drawn horizontal
 *     line. This is an explicit "write here", and it tells us the exact width
 *     the author intended. The field sits ON the line.
 *  2. A CAPTION — "Signature", "Initials", "Date", "Print Name", a lone "X".
 *     Captions normally sit BELOW the line they label (or to the right of a
 *     colon), so an uncaptured caption gets a box placed just above it.
 *
 * A caption adjacent to a ruled line TYPES that line rather than producing a
 * second field — otherwise every signature line yields two overlapping boxes.
 *
 * This is a proposal engine, not an oracle. It is tuned to under-propose:
 * a missed field costs the rep one drag, while a spurious field on a live
 * contract is a box the homeowner is asked to fill for no reason.
 */
(function (root) {
  'use strict';

  // Caption vocabulary. Order matters — 'print name' must beat 'name', and
  // 'signature' must be tested before the bare 'sign'.
  const CAPTIONS = [
    { re: /\b(?:home ?owner|customer|client|contractor|company)?\s*signature\b/i, type: 'signature' },
    { re: /\bsign\s*(?:here|below)?\s*[:.]?\s*$/i, type: 'signature' },
    { re: /\binitials?\b/i, type: 'initials' },
    { re: /\bdate\s*(?:signed)?\b/i, type: 'date' },
    { re: /\b(?:print(?:ed)?\s+name|full\s+name|name\s+of\s+insured)\b/i, type: 'text' },
    { re: /^\s*x\s*$/i, type: 'signature' },
  ];

  // Default box sizes in points, by type. Wide enough to sign into on a
  // phone; a too-small signature box is the classic e-sign annoyance.
  const SIZES = {
    signature: { w: 190, h: 46 },
    initials: { w: 64, h: 40 },
    date: { w: 120, h: 22 },
    text: { w: 180, h: 22 },
    checkbox: { w: 16, h: 16 },
  };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /** Normalised geometry for one pdf.js text item. */
  function itemBox(it) {
    const t = it.transform || [1, 0, 0, 1, 0, 0];
    const h = Math.abs(it.height || t[3] || 10) || 10;
    return {
      str: String(it.str == null ? '' : it.str),
      x: t[4],
      baseline: t[5],
      w: Math.max(0, it.width || 0),
      h,
    };
  }

  /** A run of 4+ underscores, possibly with spaces between them. */
  function isRuledText(s) {
    const t = String(s).replace(/\s+/g, '');
    return /_{4,}/.test(t);
  }

  /** Do two horizontal spans overlap by at least `frac` of the shorter one? */
  function overlapsX(a, b, frac) {
    const lo = Math.max(a.x, b.x);
    const hi = Math.min(a.x + a.w, b.x + b.w);
    const inter = hi - lo;
    if (inter <= 0) return false;
    return inter >= frac * Math.min(a.w, b.w);
  }

  function captionType(s) {
    for (const c of CAPTIONS) if (c.re.test(s)) return c.type;
    return null;
  }

  /**
   * @param {Array} textItems  pdf.js getTextContent().items for ONE page
   * @param {Object} pageSize  { w, h } in PDF points
   * @param {Object} [opts]    { pageIndex = 0, idPrefix = 'f' , lines = [] }
   *        opts.lines: optional [{x, y, w}] horizontal rules recovered from
   *        the page's drawing operators, treated exactly like underscore runs.
   * @returns {Array} proposed fields in the esign-stamp field shape
   */
  function detectFields(textItems, pageSize, opts) {
    const o = opts || {};
    const pageIndex = o.pageIndex || 0;
    const prefix = o.idPrefix || 'f';
    const PW = (pageSize && pageSize.w) || 612;
    const PH = (pageSize && pageSize.h) || 792;

    const items = (textItems || []).map(itemBox).filter((i) => i.str.trim() !== '');

    // ── 1. ruled lines: underscore runs, plus any supplied vector rules ──
    const rules = [];
    for (const it of items) {
      if (!isRuledText(it.str)) continue;
      if (it.w < 30) continue;                        // too short to sign on
      rules.push({ x: it.x, y: it.baseline, w: it.w, from: 'text' });
    }
    for (const l of (o.lines || [])) {
      if (!l || l.w < 40) continue;
      rules.push({ x: l.x, y: l.y, w: l.w, from: 'vector' });
    }

    // ── 2. captions ──────────────────────────────────────────────────────
    const captions = [];
    for (const it of items) {
      if (isRuledText(it.str)) continue;
      const type = captionType(it.str);
      if (!type) continue;
      // A long sentence that merely CONTAINS the word "date" is prose, not a
      // caption. Real captions are short.
      if (it.str.trim().length > 34) continue;
      captions.push({ type, x: it.x, y: it.baseline, w: it.w || 40, h: it.h, str: it.str.trim() });
    }

    const out = [];
    const usedCaption = new Set();
    let n = 0;
    const nextId = () => `${prefix}${pageIndex}_${n++}`;

    // ── 3. type each ruled line from the nearest caption ─────────────────
    for (const r of rules) {
      let best = null, bestD = Infinity;
      for (let i = 0; i < captions.length; i++) {
        const c = captions[i];
        // Caption below the line (the common layout), or just right of it.
        const below = r.y - c.y;
        const near =
          (below > -4 && below < 26 && overlapsX(r, { x: c.x, w: c.w }, 0.12)) ||
          (Math.abs(c.y - r.y) < 8 && c.x > r.x + r.w - 6 && c.x - (r.x + r.w) < 60) ||
          (Math.abs(c.y - r.y) < 8 && c.x + c.w < r.x + 6 && r.x - (c.x + c.w) < 60);
        if (!near) continue;
        const d = Math.abs(below) + Math.abs(c.x - r.x) * 0.05;
        if (d < bestD) { bestD = d; best = i; }
      }
      const type = best != null ? captions[best].type : 'signature';
      if (best != null) usedCaption.add(best);

      const size = SIZES[type] || SIZES.text;
      // Sit the box ON the rule: baseline at the line, box rising above it.
      const w = clamp(Math.min(r.w, size.w * 1.6), 40, r.w);
      const h = size.h;
      out.push({
        id: nextId(), type, page: pageIndex,
        x: clamp(r.x, 0, PW - 10),
        y: clamp(r.y + 1, 0, PH - h),
        w: clamp(w, 20, PW - r.x),
        h: clamp(h, 10, PH),
        required: type !== 'text',
        label: '',
        role: 'signer',
        source: 'rule',
      });
    }

    // ── 4. captions with no rule of their own get a box above them ───────
    for (let i = 0; i < captions.length; i++) {
      if (usedCaption.has(i)) continue;
      const c = captions[i];
      const size = SIZES[c.type] || SIZES.text;
      const y = c.y + c.h + 2;
      if (y + size.h > PH) continue;              // would fall off the page
      // Skip if it would land on top of a field we already proposed.
      const box = { x: c.x, y, w: size.w, h: size.h };
      const collides = out.some((f) =>
        Math.abs(f.y - box.y) < Math.max(f.h, box.h) &&
        overlapsX({ x: f.x, w: f.w }, { x: box.x, w: box.w }, 0.25));
      if (collides) continue;

      out.push({
        id: nextId(), type: c.type, page: pageIndex,
        x: clamp(c.x, 0, PW - 10),
        y: clamp(y, 0, PH - size.h),
        w: clamp(size.w, 20, PW - c.x),
        h: size.h,
        required: c.type !== 'text',
        label: '',
        role: 'signer',
        source: 'caption',
      });
    }

    return out;
  }

  /**
   * Does an uploaded contract already carry the FTC Notice of Cancellation
   * forms (16 CFR 429.1(b): two completed copies)? (review R4 D8, 2026-10-08)
   * pageItems: one pdf.js getTextContent().items array per page. True when
   * the form's own words — "NOTICE OF CANCELLATION" and "I hereby cancel this
   * transaction" — each appear at least twice. A contract that only MENTIONS
   * the notice ("see the attached Notice of Cancellation") does not count.
   * The rep's checkbox has the last word either way (a scanned PDF has no
   * text layer).
   */
  function hasCancelForms(pageItems) {
    const text = (pageItems || []).map((items) => (items || [])
      .map((it) => (it && typeof it.str === 'string') ? it.str : '').join(' ')).join(' ')
      .replace(/\s+/g, ' ');
    const heads = (text.match(/notice\s+of\s+cancell?ation/gi) || []).length;
    const lines = (text.match(/i\s+hereby\s+cancel\s+this\s+transaction/gi) || []).length;
    return heads >= 2 && lines >= 2;
  }

  const api = { detectFields, hasCancelForms, CAPTIONS, SIZES, _itemBox: itemBox, _isRuledText: isRuledText };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.NBDEsignAutodetect = api;
})(typeof window !== 'undefined' ? window : globalThis);
