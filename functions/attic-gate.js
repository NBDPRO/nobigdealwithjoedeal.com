/**
 * functions/attic-gate.js - the server side of the Attic, Ventilation & Moisture Acknowledgment (phase 3, flag
 * docAtticAckV1, default OFF). See documentation/projects/ATTIC-ACK-V1-2026-11-18.md.
 *
 *   applyAcks      the remote-signing record: the ORIGINAL document with each tick control's state taken from the
 *                  submission (only the controls the original has; nothing else from the submission is kept)
 *   resultFor      what a signed attic form says: { version, notInspected, declined, acknowledgments, formDate }
 *   decide         the send/sign gate for a contract-class document: the lead's scope, whether a signed form with a
 *                  server-written result exists, whether an owner/admin override was recorded
 *   recordOverride the owner/admin "proceed anyway" event (Q18), server-written only
 *
 * db is injected (no npm packages) so the unit tests run against a fake. Pure logic is attic-ack.js.
 */
'use strict';

const crypto = require('crypto');
const AA = require('./attic-ack');
const TXT = require('./attic-ack-text');

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const OVERRIDES = 'attic_overrides';
const CONTRACT_CLASS = ['contract', 'proposal', 'work_authorization', 'estimate_esign'];

/** Is this a document type the gate applies to? */
function gated(type) { return CONTRACT_CLASS.indexOf(String(type || '')) !== -1; }
function isAtticDoc(type) { return AA.DOC_TYPES.indexOf(String(type || '')) !== -1; }

// ── The manifest (review 2026-11-18, finding 2) ────────────────────
// The server holds what an attic form MUST contain: which controls, which of them are required, the marker for the variant and the
// packet's own wording. A stored copy that is rep-authored (the in-person path, and the remote path's original) is compared to it
// and only a match counts. The ids below mirror the renderer (document-generator-library.js renderAtticAcknowledgment); the real
// render is pinned against this in tests/attic-ack-review-2026-11-18.test.js.
const ACK_IDS = ['saw', 'declined', 'existing', 'not_inspection', 'moisture', 'tearoff'];
const STMT_IDS = ['not_checked', 'offered', 'unseen', 'no_change'];
const MAX_CONTROLS = 60;
const MARKER_RE = /<!--\s*nbd:attic-ack\s+(\S+)\s+(inspected|not_inspected)\s*-->/g;

function manifestFor(docType) {
  const t = String(docType || '');
  if (AA.DOC_TYPES.indexOf(t) === -1) return null;
  const notInspected = t === 'attic_not_inspected';
  const required = (notInspected ? STMT_IDS.map((i) => 'ack:stmt_' + i) : []).concat(ACK_IDS.map((i) => 'ack:' + i));
  const must = (TXT.RECS_THIRD_PARTY || []).map((_, i) => 'third_party_' + (i + 1));
  const lines = AA.REC_DEFS.map((d) => d.id).concat(must);
  const paras = [].concat(TXT.WHY, TXT.ACKS, [TXT.SAVINGS], notInspected ? TXT.STATEMENTS : []);
  return { variant: notInspected ? 'not_inspected' : 'inspected', required, must, lines, paras };
}

// Review 2 (2026-11-18), item 2: the stored copy is rep-authored (in-person) or a signer's submission, so it is read with one linear
// pass (indexOf and a character loop, no backtracking regex), and a copy over MAX_HTML is refused before any of it is read. The
// real form is about 20 KB; the signed copy carries two signature images, so 2 MB is generous.
const MAX_HTML = 2 * 1024 * 1024;
// Elements whose content a reader never sees as page text (or that a script could reveal): their content is not wording.
// Review 3 (item 3): a raw element opens even when written self-closing (<title/>, <style/>, <script/>: HTML ignores the slash), and textarea,
// xmp, noembed, noframes and plaintext are raw too, so a control or wording inside one is not read as part of the page.
const RAW_ELEMENTS = { script: 1, style: 1, template: 1, title: 1, noscript: 1, canvas: 1, object: 1, iframe: 1, audio: 1, video: 1, textarea: 1, xmp: 1, noembed: 1, noframes: 1, plaintext: 1 };
const VOID_ELEMENTS = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1 };
// Classes that hide an element's text in the printed or signed copy (see the style allowlist): text inside one is not wording.
const HIDDEN_CLASSES = { 'no-print': 1, 'nbd-sig-controls': 1, 'nbd-sig-state': 1 };
const MAX_DEPTH = 400;
function _classes(v) { return String(v == null ? '' : v).toLowerCase().split(/\s+/).filter(Boolean); }
function _hiddenClass(attrs) { return _classes(attrs && attrs.class).some((c) => HIDDEN_CLASSES[c] === 1); }
const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * One linear pass over the markup -> { text, tags: [{ name, closing, attrs }], styles: [{ body: css text, attrs }], unterminated }.
 * text is the page text only (comments, tags, the content of RAW_ELEMENTS and the text inside an element with a HIDDEN_CLASSES class removed).
 * A comment, tag, quote or raw element that never closes swallows the rest of the document, as a browser does: what follows it is not read as
 * wording. An element nested deeper than MAX_DEPTH ends the scan (too_deep).
 */
function _scan(html) {
  const s = String(html == null ? '' : html);
  const low = s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));   // same length as s
  const n = s.length;
  const text = []; const tags = []; const styles = [];
  let unterminated = false; let tooDeep = false;
  const stack = []; const open = {}; let hid = 0;   // open elements, how many of each name, how many carry a hidden class
  const say = (t) => { if (hid === 0) text.push(t); };
  let i = 0;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt === -1) { say(s.slice(i)); break; }
    if (lt > i) say(s.slice(i, lt));
    i = lt;
    if (low.startsWith('<!--', i)) {
      const e = s.indexOf('-->', i + 4);
      if (e === -1) { unterminated = true; break; }
      say(' '); i = e + 3; continue;
    }
    const c = low.charAt(i + 1);
    if (!((c >= 'a' && c <= 'z') || c === '/' || c === '!' || c === '?')) { say('<'); i++; continue; }
    // the tag: up to the first '>' that is not inside a quoted attribute value
    let j = i + 1; let end = -1; let prev = '';
    while (j < n) {
      const ch = s.charAt(j);
      if (ch === '>') { end = j; break; }
      if ((ch === '"' || ch === "'") && prev === '=') {
        const q = s.indexOf(ch, j + 1);
        if (q === -1) break;
        j = q + 1; prev = ch; continue;
      }
      if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r' && ch !== '\f') prev = ch;
      j++;
    }
    if (end === -1) { unterminated = true; break; }
    const raw = s.slice(i, end + 1);
    const nm = /^<(\/?)([a-z][a-z0-9:-]*)/.exec(low.slice(i, Math.min(end + 1, i + 40)));
    const attrs = {};
    if (nm) {
      const body = raw.slice(nm[0].length);
      let a; ATTR_RE.lastIndex = 0;
      while ((a = ATTR_RE.exec(body))) { const k = a[1].toLowerCase(); if (!Object.prototype.hasOwnProperty.call(attrs, k)) attrs[k] = a[2] != null ? a[2] : (a[3] != null ? a[3] : (a[4] != null ? a[4] : '')); }
      tags.push({ name: nm[2], closing: nm[1] === '/', attrs });
    }
    i = end + 1;
    if (nm && nm[1] === '' && RAW_ELEMENTS[nm[2]] === 1) {
      const close = low.indexOf('</' + nm[2], i);
      const body = close === -1 ? s.slice(i) : s.slice(i, close);
      if (nm[2] === 'style') styles.push({ body, attrs });
      tags[tags.length - 1].bodyLength = body.length;
      if (close === -1) { unterminated = true; break; }
      const gt = s.indexOf('>', close);
      if (gt === -1) { unterminated = true; break; }
      tags.push({ name: nm[2], closing: true, attrs: {} });
      i = gt + 1;
    } else if (nm && VOID_ELEMENTS[nm[2]] !== 1) {
      if (nm[1] === '') {
        if (stack.length >= MAX_DEPTH) { tooDeep = true; break; }
        const h = _hiddenClass(attrs);
        stack.push({ name: nm[2], h }); open[nm[2]] = (open[nm[2]] || 0) + 1; if (h) hid++;
      } else if (open[nm[2]] > 0) {   // a closing tag pops to its element (each element is popped once, so this is linear)
        for (;;) { const t = stack.pop(); open[t.name]--; if (t.h) hid--; if (t.name === nm[2]) break; }
      }
    }
  }
  return { text: text.join(''), tags, styles, unterminated, tooDeep };
}

function _norm(t) {
  return String(t)
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0*39;|&#x27;/g, "'").replace(/&amp;/g, '&')
    .replace(/\*\*/g, '').replace(/\bNBD\b/g, 'Contractor').replace(/at least (\d+|\{\{atticFreeCheckDays\}\}) days/g, 'at least N days').replace(/\s+/g, ' ').trim();
}
function _plain(s) { return _norm(_scan(s).text); }

// Review 2 (2026-11-18), item 3: wording that is in the markup but not on the page. The form the server issues has no template element,
// no hidden attribute, and no inline style except a margin; its style blocks are the allowlist below. Anything else fails.
const SAFE_STYLE_RE = /^(?:\s*margin(?:-(?:top|bottom|left|right))?\s*:\s*[0-9.]+(?:px|em|rem|pt)?\s*;?)+\s*$/i;
const SIG_IMG_STYLE = 'max-width:100%;height:auto;display:block;background:#fff;';
const HIDING_CSS_RES = [
  /display:none/, /visibility:(?:hidden|collapse)/, /content-visibility:hidden/, /font-size:(?:0+(?:\.0*)?|\.0+)(?:px|pt|em|rem|ex|%)?(?![0-9.])/, /opacity:(?:0+(?:\.0*)?|\.0+)(?![0-9.])/,
  /color:transparent/, /text-indent:-/, /(?<![a-z-])(?:max-)?(?:height|width):(?:0+(?:\.0*)?|\.0+)(?:px|pt|em|rem|ex|%)?(?![0-9.])/, /(?<![a-z-])line-height:(?:0+(?:\.0*)?|\.0+)(?![0-9.])/,
  /clip(?:-path)?:/, /@import/, /(?:left|top|right|bottom|margin-left|margin-top):-[0-9]{3,}/,
];
const ALLOWED_TAGS = {};
('html head meta title style body div p span strong em b i small sup sub br hr label input table thead tbody tfoot tr td th h1 h2 h3 ul ol li dl dt dd img canvas button script').split(' ').forEach((n) => { ALLOWED_TAGS[n] = 1; });
const GLOBAL_ATTRS = { class: 1, id: 1, style: 1, lang: 1 };
const TAG_ATTRS = {
  img: { src: 1, alt: 1, width: 1, height: 1 }, canvas: { width: 1, height: 1 },
  input: { type: 1, name: 1, 'data-nbd-ack': 1, 'data-nbd-required': 1, 'aria-label': 1, checked: 1, disabled: 1 },
  button: { type: 1, 'data-nbd-sig-action': 1, 'data-dgt-action': 1 }, meta: { charset: 1, name: 1, content: 1 }, script: { src: 1, defer: 1 },
  div: { 'data-nbd-sig': 1, 'data-label': 1, 'data-required': 1, 'data-nbd-sig-finalized': 1, 'data-nbd-sig-signed-at': 1 }, td: { colspan: 1, rowspan: 1 }, th: { colspan: 1, rowspan: 1 },
};
// The elements that carry the required wording may have only the classes the server render writes (a class is not a way to hide text
// once the style blocks are an allowlist, but an unknown class on a paragraph is not the server's form).
const WORD_CARRIERS = { p: 1, label: 1, strong: 1, em: 1, h1: 1, h2: 1, h3: 1, li: 1, span: 1 };
const WORD_CLASSES = { 'aa-p': 1, 'aa-note': 1, 'aa-ver': 1, 'aa-row': 1, 'lib-sub': 1, 'lib-h1': 1, 'lib-fine': 1, 'footer-brand': 1, 'nbd-sig-state': 1 };
// The signing widget's script: no body, and a source on this site's own path.
const SCRIPT_SRC_RE = /^(?:https?:\/\/(?:[a-z0-9-]{1,63}\.){0,4}(?:nobigdealwithjoedeal\.com|localhost|127\.0\.0\.1)(?::[0-9]{1,5})?)?\/pro\/js\/signature-widget\.js$/i;
const WORDING_TAGS = { p: 1, label: 1, span: 1, strong: 1, em: 1, td: 1, th: 1, tr: 1, tbody: 1, thead: 1, table: 1, li: 1, ul: 1, ol: 1, h1: 1, h2: 1, h3: 1, input: 1 };

/** The CSS text lower-cased, with comments and white space removed (linear: indexOf, no backtracking regex). */
function _cssFlat(css) {
  const t = String(css).toLowerCase(); let out = ''; let i = 0;
  for (;;) {   // /* */ comments
    const a = t.indexOf('/*', i);
    if (a === -1) { out += t.slice(i); break; }
    out += t.slice(i, a); const e = t.indexOf('*/', a + 2);
    if (e === -1) break;
    i = e + 2;
  }
  return out.replace(/\s+/g, '').replace(/!important/g, '');
}

/** transform:...scale(0 inside one declaration (no ';' or '}' between). One pass: the old /transform:[^;}]*scale(0/ rescanned the rest for every 'transform:'. */
function _scaleZero(flat) {
  let t = -1;
  for (let i = 0; i < flat.length; i++) {
    const ch = flat.charAt(i);
    if (ch === ';' || ch === '}') { t = -1; continue; }
    if (t === -1 && ch === 't' && flat.startsWith('transform:', i)) { t = i; continue; }
    if (t !== -1 && ch === 's' && flat.startsWith('scale(0', i)) return true;
  }
  return false;
}
function _hidingCss(css) {
  const flat = _cssFlat(css);
  return HIDING_CSS_RES.some((re) => re.test(flat)) || _scaleZero(flat);
}

// Review 3 (2026-11-18), item 1: the form may carry only the style blocks the server knows. The generator injects <style id="nbd-sig-styles">
// (its print rule hides the signing controls), the form has its own block, and the page has its own block, which opens with the print rule
// (that rule hides the print button). An allowlist: each block must EQUAL a known one (white space normalised), or - the page block, whose
// colours and fonts follow the tenant's brand - open with the exact print rule and then hold only rules from the property allowlist below.
// Anything else is a style_block; hiding constructs in it are also named css_hidden.
const _ws = (t) => String(t).replace(/\s+/g, ' ').trim();
const CSS_PROPS = {};
('font-family font-size font-weight font-style line-height letter-spacing text-transform text-align color background box-sizing display flex flex-wrap flex-direction flex-shrink justify-content align-items gap ' +
  'position left bottom top right content width height max-width min-width min-height max-height object-fit object-position cursor border border-radius border-collapse font-variant-numeric opacity ' +
  'border-top border-bottom border-left border-right margin margin-top margin-bottom margin-left margin-right padding padding-top padding-bottom padding-left padding-right').split(' ').forEach((p) => { CSS_PROPS[p] = 1; });
const SEL_RE = /^[a-z0-9_.#:>+~*(), -]+$/i;
const VAL_RE = /^[a-z0-9#%.,()'" _:\/!-]*$/i;
function _pageCssOk(css) {
  if (css.indexOf('/*') !== -1 || css.indexOf('@') !== -1 || css.indexOf('\\') !== -1) return false;
  const n = css.length; let i = 0;
  while (i < n) {
    while (css.charAt(i) === ' ') i++;
    if (i >= n) break;
    const ob = css.indexOf('{', i); if (ob === -1) return false;
    if (!SEL_RE.test(css.slice(i, ob).trim())) return false;
    const cb = css.indexOf('}', ob + 1); if (cb === -1) return false;
    const body = css.slice(ob + 1, cb);
    if (body.indexOf('{') !== -1) return false;
    const decls = body.split(';');
    for (let k = 0; k < decls.length; k++) {
      const d = decls[k].trim(); if (!d) continue;
      const c = d.indexOf(':'); if (c < 1) return false;
      const prop = d.slice(0, c).trim().toLowerCase(); const val = d.slice(c + 1).trim();
      if (CSS_PROPS[prop] !== 1 || !VAL_RE.test(val)) return false;
      const lv = val.toLowerCase();
      if (lv.indexOf('url(') !== -1 || lv.indexOf('expression') !== -1 || lv.indexOf('attr(') !== -1) return false;
      if (prop === 'display' && lv.indexOf('none') === 0) return false;
      if (prop === 'content' && val !== '""') return false;
    }
    i = cb + 1;
  }
  return true;
}
/** Reason codes for the page's style blocks (empty when every block is one the server knows). */
function _styleReasons(blocks) {
  const bad = []; const add = (c) => { if (bad.indexOf(c) === -1) bad.push(c); };
  const sig = _ws(AA.SIG_STYLES_CSS); const attic = _ws(AA.ATTIC_FORM_CSS); const pr = _ws(AA.PRINT_RULE_CSS);
  const seen = { sig: 0, attic: 0, page: 0 };
  blocks.forEach((b) => {
    const body = _ws(b.body); const names = Object.keys(b.attrs || {});
    if (body === sig && names.length === 1 && names[0] === 'id' && b.attrs.id === 'nbd-sig-styles') { seen.sig++; return; }
    if (body === attic && names.length === 0) { seen.attic++; return; }
    if (names.length === 0 && body.indexOf(pr) === 0 && _pageCssOk(body.slice(pr.length).trim()) && !_hidingCss(body.slice(pr.length))) { seen.page++; return; }
    add('style_block');
    if (_hidingCss(body)) add('css_hidden');
  });
  Object.keys(seen).forEach((k) => { if (seen[k] > 1) add('style_block'); });
  return bad;
}

/**
 * Reasons the markup can show something other than what the text says (hidden wording, pre-ticked boxes). signed: the copy is a SIGNED one,
 * where ticks are expected. Original copies (the remote path's, and every stored form before it is signed) carry no tick at all.
 */
function _risks(scan, parsed, opts) {
  const bad = [];
  const add = (c) => { if (bad.indexOf(c) === -1) bad.push(c); };
  if (scan.tooDeep) add('too_deep');
  let noPrint = 0;
  scan.tags.forEach((t) => {
    // Review 3 (item 3): the tags and attributes of the form are an allowlist (what the server render and the signing step write).
    if (ALLOWED_TAGS[t.name] !== 1) add('bad_tag:' + String(t.name).slice(0, 20));
    if (t.closing) return;
    const a = t.attrs;
    Object.keys(a).forEach((k) => { if (!(GLOBAL_ATTRS[k] === 1 || (TAG_ATTRS[t.name] && TAG_ATTRS[t.name][k] === 1))) add('bad_attr:' + String(k).slice(0, 30)); });
    const cls = _classes(a.class);
    if (cls.indexOf('no-print') !== -1) {   // the print button's own wrapper is the only element that may carry it
      noPrint++;
      if (!(t.name === 'div' && cls.slice().sort().join(' ') === 'no-print print-btn' && noPrint === 1)) add('no_print_wording');
    }
    if (cls.indexOf('nbd-sig-controls') !== -1 && t.name !== 'div') add('hidden_class');
    if (cls.indexOf('nbd-sig-state') !== -1 && t.name !== 'span') add('hidden_class');
    if (WORD_CARRIERS[t.name] === 1 && cls.some((c) => WORD_CLASSES[c] !== 1)) add('bad_class');
    if (t.name === 'script' && (!(t.bodyLength === 0) || !SCRIPT_SRC_RE.test(String(a.src || '').slice(0, 200)))) add('script');
    if (t.name === 'template') add('template');
    if (Object.prototype.hasOwnProperty.call(a, 'hidden')) add('hidden_attr');
    // The one inline style a signed copy gets is the signature image's own (signature-widget.js and remote-signing.js finalizeBlock write it).
    const sigImg = t.name === 'img' && /(?:^|\s)nbd-sig-img(?:\s|$)/.test(a.class || '') && String(a.style || '').replace(/\s+/g, '').toLowerCase() === SIG_IMG_STYLE;
    if (Object.prototype.hasOwnProperty.call(a, 'style') && !sigImg && !SAFE_STYLE_RE.test(a.style)) add('inline_style');
    if (t.name === 'link' && /stylesheet/i.test(a.rel || '')) add('css_hidden');
    if (WORDING_TAGS[t.name] === 1 && /(?:^|\s)no-print(?:\s|$)/i.test(a.class || '')) add('no_print_wording');
    if (Object.prototype.hasOwnProperty.call(a, 'data-nbd-ack')) {
      const ty = String(a.type == null ? '' : a.type).trim().toLowerCase();
      if (t.name !== 'input' || (ty !== 'checkbox' && ty !== 'radio')) add('control_type');
      if (opts.signed !== true && Object.prototype.hasOwnProperty.call(a, 'checked')) add('preticked');
    }
  });
  if (opts.signed !== true && parsed.some((c) => c.checked === true)) add('preticked');
  _styleReasons(scan.styles).forEach(add);
  return bad;
}

/**
 * Is this stored HTML the attic form the server would have issued for this document type? -> { ok, reasons: [code] }
 * Same controls (ids, types, required flags), the variant marker for the type, and the packet's paragraphs. Ticks are not part of
 * it (a signed copy has them). Anything else - an extra, missing or non-required control, a stripped flag, hand-written HTML - fails.
 */
function verifyManifest(docType, html, opts) {
  const o = opts || {};
  const m = manifestFor(docType);
  const bad = [];
  if (!m) return { ok: false, reasons: ['doc_type'] };
  const s = String(html == null ? '' : html);
  if (s.length > MAX_HTML) return { ok: false, reasons: ['too_large'] };
  const markers = []; let mm; MARKER_RE.lastIndex = 0;
  while ((mm = MARKER_RE.exec(s))) markers.push(mm);
  if (markers.length !== 1 || markers[0][1] !== AA.VERSION || markers[0][2] !== m.variant) bad.push('marker');
  const parsed = AA.parseAcks(s);
  const scan = _scan(s);
  const rawCount = (s.match(/data-nbd-ack/gi) || []).length;
  // Review 3 (item 3): a control counts only when it is a real tag of the page, not text in a comment, textarea, noscript or template.
  const liveCount = scan.tags.filter((t) => !t.closing && Object.prototype.hasOwnProperty.call(t.attrs, 'data-nbd-ack')).length;
  if (parsed.length !== rawCount || parsed.length !== liveCount || parsed.length > MAX_CONTROLS) bad.push('control_count');
  const seen = {};
  parsed.forEach((c) => { if (seen[c.id]) bad.push('duplicate:' + c.id); seen[c.id] = c; });
  const boxes = parsed.filter((c) => c.type === 'checkbox').map((c) => c.id).sort();
  const reqs = m.required.slice().sort();
  if (boxes.join('|') !== reqs.join('|')) bad.push('checkboxes');
  parsed.filter((c) => c.type === 'checkbox').forEach((c) => { if (c.required !== true) bad.push('not_required:' + c.id); });
  const groups = {};
  parsed.filter((c) => c.type === 'radio').forEach((c) => {
    const r = /^rec:([a-z_0-9]+):(yes|no)$/.exec(c.id);
    if (!r || m.lines.indexOf(r[1]) === -1) { bad.push('radio_id:' + c.id); return; }
    if (c.required) bad.push('radio_required:' + c.id);
    (groups[r[1]] = groups[r[1]] || {})[r[2]] = true;
  });
  Object.keys(groups).forEach((g) => { if (!(groups[g].yes && groups[g].no)) bad.push('half_line:' + g); });
  m.must.forEach((g) => { if (!groups[g]) bad.push('missing_line:' + g); });
  if (scan.unterminated) bad.push('unterminated');
  const text = _norm(scan.text);
  m.paras.forEach((p, i) => { if (text.indexOf(_plain(p)) === -1) bad.push('wording:' + i); });
  _risks(scan, parsed, o).forEach((c) => bad.push(c));
  return { ok: bad.length === 0, reasons: bad.slice(0, 12) };
}

/** The doc type the marker names (for a caller with no type of its own). */
function typeFromMarker(html) {
  const r = /<!--\s*nbd:attic-ack\s+\S+\s+(inspected|not_inspected)\s*-->/.exec(String(html || ''));
  return r && r[1] === 'not_inspected' ? 'attic_not_inspected' : 'attic_acknowledgment';
}

/**
 * The executed record for a document that carries tick controls: the original's markup, with `checked` and
 * `disabled` written onto each control from the submission's state. Returns { html, acks, complete }.
 * A control the submission added (an id the original does not have) is ignored.
 */
function applyAcks(originalHtml, signedHtml, docType) {
  const orig = String(originalHtml == null ? '' : originalHtml);
  // The ORIGINAL is rep-authored: it must be the server's own form for this type before any of it is rewritten (size and shape first).
  const manifest0 = verifyManifest(docType || typeFromMarker(orig), orig);
  if (!manifest0.ok || String(signedHtml == null ? '' : signedHtml).length > MAX_HTML) {
    return { html: orig, acks: [], manifestOk: false, manifestReasons: manifest0.ok ? ['too_large'] : manifest0.reasons, complete: false };
  }
  const sub = {};
  AA.parseAcks(signedHtml).forEach((a) => { sub[a.id] = a.checked === true; });
  const rewrite = (tag) => {
    const m = /\bdata-nbd-ack\s*=\s*"([^"]{1,80})"/i.exec(tag);
    if (!m) return tag;
    const bare = tag.replace(/\s(checked|disabled)(\s*=\s*"[^"]*")?(?=[\s\/>])/gi, '');
    // The tag ends in '>' (it was cut at one). Its closing is found by a backward walk (review 3, item 2): the regex this replaces,
    // /\s*(\/?)>$/, rescanned the rest of the tag from every white-space character, so a tag padded with 1 MB of spaces took minutes.
    let e = bare.length - 1;                                  // the '>'
    const slash = e > 0 && bare.charAt(e - 1) === '/';
    if (slash) e--;
    while (e > 0 && /\s/.test(bare.charAt(e - 1))) e--;       // white space before the '/' or '>'
    return bare.slice(0, e) + (sub[m[1]] === true ? ' checked=""' : '') + ' disabled=""' + (slash ? ' />' : '>');
  };
  // Each <input ...> tag is found with indexOf (linear), the same tag boundaries parseAcks uses.
  const out = []; const inRe = /<input\b/gi; let last = 0; let im;
  while ((im = inRe.exec(orig))) {
    const gt = orig.indexOf('>', im.index);
    if (gt === -1) break;
    out.push(orig.slice(last, im.index), rewrite(orig.slice(im.index, gt + 1)));
    last = gt + 1; inRe.lastIndex = gt + 1;
  }
  out.push(orig.slice(last));
  const html = out.join('');
  const acks = AA.parseAcks(html);
  return { html, acks, manifestOk: true, manifestReasons: [], complete: acks.length > 0 && AA.acksComplete(acks).ok };
}

/** What a signed attic form records, from the stored signed copy. */
function resultFor(docType, signedHtml, formDateMs) {
  const manifest = verifyManifest(docType, signedHtml, { signed: true });
  const acks = manifest.reasons.indexOf('too_large') === -1 ? AA.parseAcks(signedHtml) : [];
  return {
    version: AA.VERSION,
    notInspected: String(docType) === 'attic_not_inspected',
    declined: AA.declinedAny(acks),
    manifestOk: manifest.ok,
    complete: manifest.ok && acks.length > 0 && AA.acksComplete(acks).ok,
    acknowledgments: AA.evidenceAcks(acks),
    formDateMs: Number.isFinite(Number(formDateMs)) ? Number(formDateMs) : null,
  };
}

const okId = (v) => typeof v === 'string' && ID_RE.test(v);

/** A short digest of an estimate's priced content: an override is bound to it, so a re-priced or re-scoped estimate needs a new one. */
function estimateStamp(est) {
  const e = est || {};
  return crypto.createHash('sha256').update(JSON.stringify([e.rows || [], e.lineItems || [], e.grandTotal == null ? null : e.grandTotal])).digest('hex').slice(0, 16);
}

/**
 * Every estimate in play for this send (review 2026-11-18, finding 1): the one actually being sent (o.estimate / o.estimateId),
 * the lead's primary, and - only when neither resolves - the lead's own estimates. The first of these is the BASIS an override
 * is bound to. A read that fails throws (the caller fails closed).
 */
async function _estimateSet(db, leadId, lead, o) {
  const list = [];
  const seen = {};
  const add = (id, data) => { if (data && !seen[id]) { seen[id] = true; list.push({ id, data }); } };
  let basis = null;
  if (o.estimate && typeof o.estimate === 'object') { basis = { id: okId(o.estimateId) ? o.estimateId : '', data: o.estimate }; }
  else if (okId(o.estimateId)) {
    const s = await db.doc('estimates/' + o.estimateId).get();
    if (s && s.exists) basis = { id: o.estimateId, data: s.data() || {} };
  }
  if (basis) add(basis.id, basis.data);
  const pid = okId(lead && lead.primaryEstimateId) ? lead.primaryEstimateId : '';
  if (pid && !seen[pid]) {
    const s = await db.doc('estimates/' + pid).get();
    if (s && s.exists) { const d = s.data() || {}; add(pid, d); if (!basis) basis = { id: pid, data: d }; }
  }
  if (!list.length && okId(leadId)) {
    const q = await db.collection('estimates').where('leadId', '==', leadId).limit(20).get();
    q.docs.forEach((d) => { const x = d.data() || {}; if (x.deleted !== true) add(d.id, x); });
    if (!basis && list.length === 1) basis = list[0];
  }
  return { list, basis: basis ? { id: basis.id, stamp: estimateStamp(basis.data) } : { id: '', stamp: '' } };
}

/** The estimate (id and stamp) a form signed NOW covers: the lead's primary estimate (else its only one). A read that fails throws. */
async function formBasis(db, leadId, lead) {
  return (await _estimateSet(db, leadId, lead || {}, {})).basis;
}

/**
 * The gate for a contract-class document on this lead. A read that fails THROWS (the caller fails closed; a
 * missing attic form is never assumed). opts = { estimate, estimateId } the estimate actually being sent (else the lead's
 * primary), requireResolved (a deal with no lead: refuse when no estimate resolves), noWrite.
 * -> { scope, basis: { id, stamp }, required, satisfied, how, message, warn }
 * An override (kind 'proceed') or a lowered scope (kind 'scope_lowered') counts only while it is not revoked, not expired and
 * bound to THIS basis estimate (id and stamp): a re-priced or re-scoped estimate needs a new one.
 */
async function decide(db, leadId, lead, opts) {
  const o = opts || {};
  const L = lead || {};
  const set = await _estimateSet(db, leadId, L, o);
  // A deal with no resolvable lead and no estimate cannot be classified: refuse (never assume "not a re-roof").
  if (o.requireResolved === true && !set.list.length && AA.effectiveScope(L, []) === 'other') {
    return { scope: 'unknown', basis: set.basis, required: true, satisfied: false, how: null, warn: false,
      message: 'This deal is not linked to a customer or an estimate, so the attic acknowledgment cannot be checked. Link the deal to the customer, then send it. Nothing was sent.' };
  }
  let scope = AA.effectiveScope(L, set.list.map((x) => x.data));
  const rawScope = scope;
  // Overrides recorded on this lead that are still good for this basis.
  let valid = [];
  if (okId(leadId) && AA.scopeRank(scope) >= 2) {
    const ov = await db.collection(OVERRIDES).where('leadId', '==', leadId).get();
    const now = Date.now();
    valid = ov.docs.map((d) => d.data() || {}).filter((v) => v.version === AA.VERSION && !v.revokedAt && typeof v.expiresAt === 'number' && v.expiresAt > now
      && String(v.estimateId || '') === set.basis.id && String(v.estimateStamp || '') === set.basis.stamp);
    const lowered = valid.filter((v) => v.kind === 'scope_lowered' && AA.SCOPES.indexOf(v.toScope) !== -1 && AA.scopeRank(v.toScope) < AA.scopeRank(rawScope))[0];
    if (lowered) scope = lowered.toScope;
  }
  const g0 = AA.gate({ scope, signedForm: false, override: false });
  if (!g0.required) return Object.assign({ scope, rawScope, basis: set.basis }, g0);
  // Remember that this was a re-roof (server-owned floor): taking the tear-off line off the estimate later does not lower it.
  if (L.atticScopeFloor !== 'reroof' && okId(leadId) && o.noWrite !== true) {
    try { await db.doc('leads/' + leadId).set({ atticScopeFloor: 'reroof' }, { merge: true }); } catch (_) { /* the gate below is the control */ }
  }
  // No lead: no signed form can exist (the forms live on the lead) and no override can be recorded: the gate stays closed.
  if (!okId(leadId)) return Object.assign({ scope, rawScope, basis: set.basis }, AA.gate({ scope, signedForm: false, override: false }));
  const found = [];
  for (const t of AA.DOC_TYPES) {
    const snap = await db.collection('leads/' + leadId + '/documents').where('type', '==', t).get();
    snap.docs.forEach((d) => found.push(d));
  }
  // A form counts only with the server-written result (atticAckResult, server-owned in firestore.rules): the row's
  // own status and signedAt are written by the rep's browser on the in-person path.
  // Review 2 (item 4): a deleted row never counts, and a form covers the estimate (id and stamp) it was signed against - the same binding an
  // override has - so a form signed for an older estimate cannot satisfy a newer, re-priced or re-scoped re-roof estimate.
  const signedForm = found.some((d) => {
    const r = d.data() || {};
    if (r.deleted === true || String(r.status || '') === 'deleted') return false;
    const res = r.atticAckResult;
    return AA.isSignedForm(r) && !!res && res.version === AA.VERSION && res.complete === true
      && String(res.estimateId || '') === set.basis.id && String(res.estimateStamp || '') === set.basis.stamp;
  });
  const override = valid.some((v) => v.kind !== 'scope_lowered');
  return Object.assign({ scope, rawScope, basis: set.basis }, AA.gate({ scope, signedForm, override }));
}

const OVERRIDE_DAYS = 30;

/** The owner or admin of THIS tenant: the platform admin, the tenant's company_admin, or the tenant's own owner (uid is the tenant). */
function _ownerOrAdmin(auth, lead) {
  const uid = auth && auth.uid;
  const token = (auth && auth.token) || {};
  // Review 2 (item 4): a legacy lead with no companyId has no company owner. lead.userId is whoever created the lead (a rep), so it is never
  // read as the owner here: only a platform admin can approve on such a lead.
  const companyId = String(lead.companyId || '');
  const role = String(token.role || '');
  const tokenCo = typeof token.companyId === 'string' ? token.companyId : '';
  // A member of a company is never its owner just because they created the lead (review 2026-11-18, finding 6).
  return role === 'admin' || (companyId !== '' && ((role === 'company_admin' && tokenCo !== '' && tokenCo === companyId) || uid === companyId));
}

/**
 * Q18: only an owner or admin may record "proceed anyway" (kind 'proceed'), or lower a job's scope (kind 'scope_lowered', with
 * toScope), with a required reason, as a server-written event (name, uid, time, reason) bound to the estimate it covers, good for
 * 30 days. { revoke: true, overrideId? } ends them. auth = { uid, token }. Throws via the thrower (no firebase-functions import).
 * deps.flagOn(lead) is the lead-aware flag check (the acting user's OR the tenant owner's, strict).
 */
async function recordOverride(db, auth, data, fail, deps) {
  const uid = auth && auth.uid;
  if (!uid) throw fail('unauthenticated', 'Sign in required');
  const token = (auth && auth.token) || {};
  const d = data || {};
  const leadId = typeof d.leadId === 'string' ? d.leadId.trim() : '';
  const reason = typeof d.reason === 'string' ? d.reason.trim() : '';
  if (!ID_RE.test(leadId)) throw fail('invalid-argument', 'leadId required');
  const ls = await db.doc('leads/' + leadId).get();
  if (!ls.exists) throw fail('not-found', 'Lead not found');
  const lead = ls.data() || {};
  if (lead.deleted === true) throw fail('not-found', 'Lead not found');
  const companyId = String(lead.companyId || lead.userId || '');
  if (!_ownerOrAdmin(auth, lead)) throw fail('permission-denied', 'Only the company owner or an admin can approve a job to proceed without a signed attic page.');
  if (deps && typeof deps.flagOn === 'function' && !(await deps.flagOn(lead))) throw fail('failed-precondition', 'The attic acknowledgment is not turned on for your account.');
  const now = Date.now();
  if (d.revoke === true) {
    const snap = await db.collection(OVERRIDES).where('leadId', '==', leadId).get();
    let n = 0;
    for (const x of snap.docs) {
      const v = x.data() || {};
      if (v.revokedAt || (typeof d.overrideId === 'string' && d.overrideId && x.id !== d.overrideId)) continue;
      await db.doc(OVERRIDES + '/' + x.id).set({ revokedAt: now, revokedBy: uid }, { merge: true });
      n++;
    }
    return { ok: true, revoked: n };
  }
  const kind = d.kind === 'scope_lowered' ? 'scope_lowered' : 'proceed';
  if (reason.length < 10 || reason.length > 500) throw fail('invalid-argument', kind === 'scope_lowered' ? 'Give the reason this job is not at that scope (at least 10 characters).' : 'Give the reason the job proceeds without a signed attic page (at least 10 characters).');
  let estimateId;
  if (d.estimateId != null && d.estimateId !== '') {
    if (!okId(d.estimateId)) throw fail('invalid-argument', 'estimateId is not valid');
    const es = await db.doc('estimates/' + d.estimateId).get();
    const e = es && es.exists ? (es.data() || {}) : null;
    if (!e) throw fail('not-found', 'Estimate not found');
    if (!(e.userId === lead.userId || e.userId === companyId || e.companyId === companyId || e.leadId === leadId)) throw fail('permission-denied', 'That estimate is not on this customer.');
    estimateId = d.estimateId;
  }
  const gate = await decide(db, leadId, lead, { estimateId, noWrite: true });
  const name = String((token.name || token.email || '')).slice(0, 120);
  const rec = { leadId, companyId, byUid: uid, byName: name || null, kind, reason, scope: gate.scope, estimateId: gate.basis.id, estimateStamp: gate.basis.stamp, at: now, expiresAt: now + OVERRIDE_DAYS * 86400000, version: AA.VERSION };
  if (kind === 'scope_lowered') {
    const to = typeof d.toScope === 'string' ? d.toScope : '';
    const from = gate.rawScope || gate.scope;
    if (AA.SCOPES.indexOf(to) === -1 || !(AA.scopeRank(to) < AA.scopeRank(from))) throw fail('failed-precondition', 'The scope can only be lowered to something below its current level (' + from + ').');
    rec.toScope = to; rec.scope = from;
  } else if (!gate.required) {
    throw fail('failed-precondition', 'This job does not need an attic acknowledgment.');
  }
  const ref = db.collection(OVERRIDES).doc();
  await ref.set(rec);
  // The lowering is the one write to the lead's scope that is allowed to go down: server-side, with the event above as its record.
  if (kind === 'scope_lowered') await db.doc('leads/' + leadId).set({ scope: rec.toScope }, { merge: true });
  return { ok: true, id: ref.id, expiresAt: rec.expiresAt };
}

const TOO_LARGE_MSG = 'This attic acknowledgment is too large to verify. Open the customer, create a fresh copy of the form and try again.';

module.exports = { estimateStamp, manifestFor, verifyManifest, OVERRIDES, MAX_HTML, TOO_LARGE_MSG, formBasis, gated, isAtticDoc, applyAcks, resultFor, decide, recordOverride };
