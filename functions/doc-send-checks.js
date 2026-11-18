/**
 * doc-send-checks.js — the fail-closed check a CONTRACT-class document passes
 * before it may be sent or signed (Jo, 2026-11-18, template/liability overhaul,
 * phase 1; design principle 3, "silence never prints as a default promise").
 *
 * A contract with a blank price, property address, homeowner name, contractor
 * mailing address, start or completion, no legal entity name, or a leftover
 * [Bracket Placeholder] / {{unresolved}} token is REFUSED, with a plain list of
 * what is missing. It adds no wording to any document; it only stops a document
 * with a hole from going out.
 *
 * Pure: facts in, a list out. The caller (the doc pre-flight modal and
 * NBDDocGen.generate on the client, sendEstimateEnvelope and the PDF builder on
 * the server) reads the facts from its own source; the rules live here once.
 * Only active behind the feature flag docEvidenceFoundation (default OFF) — the
 * callers decide that, this file never reads a flag.
 *
 * ONE MODULE, TWO COPIES, like ky-insurance-law.js: docs/pro/js/doc-send-checks.js
 * (window.NBDDocSendChecks) and functions/doc-send-checks.js, pinned
 * byte-identical after EOL normalisation by tests/clause-evidence-foundation-2026-11-18.test.js.
 * Edit this one, then copy it over.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NBDDocSendChecks = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // The document types that bind the homeowner: the contract, a proposal signed
  // as the contract, the work authorization, and the server e-sign estimate PDF
  // (type 'estimate_esign': priced, no start/completion line).
  var CONTRACT_CLASS = ['contract', 'proposal', 'work_authorization', 'estimate_esign'];
  // Of those, the ones that print a contract price.
  var PRICED = ['contract', 'proposal', 'estimate_esign'];

  function isContractClass(type) { return CONTRACT_CLASS.indexOf(String(type || '')) !== -1; }
  function carriesPrice(type) { return PRICED.indexOf(String(type || '')) !== -1; }

  function _blank(v) { return v == null || String(v).replace(/[\s\u00a0]+/g, '') === ''; }

  // A document longer than this is refused, not scanned (review 2026-11-18): the check is
  // linear now, but an unbounded body on the send path is still a cost nobody asked for.
  var MAX_TEXT = 2 * 1024 * 1024;
  function tooLarge(html) { return String(html == null ? '' : html).length > MAX_TEXT; }

  var ENT = [[/&nbsp;/g, ' '], [/&amp;/g, '&'], [/&#39;/g, "'"], [/&quot;/g, '"']];

  // The text of a rendered document with the markup, <script>/<style> bodies and comments
  // removed, in ONE linear pass (review 2026-11-18). A '<' only opens a tag when a tag
  // follows (letter, '/', '!' or '?') AND a '>' closes it; a stray '<' ("a < b") is text, so
  // it can no longer swallow a later [Placeholder]. keepTags leaves the tags in (a raw scan
  // that still skips script/style/comments).
  function strip(html, keepTags) {
    var src = String(html == null ? '' : html);
    var low = src.toLowerCase();
    var out = [];
    var i = 0, n = src.length;
    var gtGone = false;            // no '>' left anywhere ahead: every later '<' is text
    var noClose = { script: false, style: false };
    while (i < n) {
      var lt = src.indexOf('<', i);
      if (lt < 0) { out.push(src.slice(i)); break; }
      if (lt > i) out.push(src.slice(i, lt));
      var c = src.charAt(lt + 1);
      if (src.substr(lt, 4) === '<!--') {
        var ce = src.indexOf('-->', lt + 4);
        out.push(' ');
        if (ce < 0) { i = n; } else { i = ce + 3; }
        continue;
      }
      var isTagStart = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '/' || c === '!' || c === '?';
      if (!isTagStart || gtGone) { out.push('<'); i = lt + 1; continue; }
      var gt = src.indexOf('>', lt + 1);
      if (gt < 0) { gtGone = true; out.push('<'); i = lt + 1; continue; }
      var block = '';
      if (low.substr(lt, 7) === '<script' && /[\s>\/]/.test(low.charAt(lt + 7))) block = 'script';
      else if (low.substr(lt, 6) === '<style' && /[\s>\/]/.test(low.charAt(lt + 6))) block = 'style';
      if (block && !noClose[block]) {
        var close = low.indexOf('</' + block, gt + 1);
        if (close >= 0) {
          var cgt = src.indexOf('>', close);
          out.push(' ');
          i = cgt < 0 ? n : cgt + 1;
          continue;
        }
        noClose[block] = true;   // no closer ahead: later ones have none either (keeps this linear)
      }
      out.push(keepTags ? src.slice(lt, gt + 1) : ' ');
      i = gt + 1;
    }
    return out.join('');
  }

  // Visible text of a rendered document: no <script>/<style>, no tags.
  function visibleText(html) {
    var t = strip(html, false);
    for (var k = 0; k < ENT.length; k++) t = t.replace(ENT[k][0], ENT[k][1]);
    return t.replace(/\s+/g, ' ');
  }

  // {{token}} and [Capitalised Words] (a template's "fill me in" marker). "[ ]" and
  // "[x]" checkboxes and lowercase brackets are not placeholders.
  var BRACE_RE = /\{\{[^{}]{1,60}\}\}/g;
  var BRACKET_RE = /\[[A-Z][A-Za-z0-9 #\/.'&-]{1,40}\]/g;

  /**
   * The distinct placeholder tokens left in rendered text or HTML: in the visible text, and
   * in the raw markup with only script/style/comments removed (so a token in an attribute is
   * not missed). Over MAX_TEXT it returns [] and contractGaps reports the size instead.
   */
  function placeholdersIn(htmlOrText) {
    if (tooLarge(htmlOrText)) return [];
    var found = [];
    [visibleText(htmlOrText), strip(htmlOrText, true)].forEach(function (t) {
      (t.match(BRACE_RE) || []).concat(t.match(BRACKET_RE) || []).forEach(function (m) {
        if (found.indexOf(m) === -1) found.push(m);
      });
    });
    return found;
  }

  /**
   * The gaps that stop a contract-class document.
   * f = {
   *   type            document type ('contract' | 'proposal' | 'work_authorization')
   *   priceCents      integer cents, or null/undefined when blank   (priced types only)
   *   address         property address
   *   homeownerName
   *   mailingAddress  the contractor's mailing address
   *   needsMailingAddress  true when this document prints the cancellation notice/forms
   *   entityName      the contractor's legal entity name
   *   startDate, estimatedCompletion   (type 'contract' only)
   *   text            the rendered document (HTML or text), scanned for placeholders
   * }
   * -> [{ code, message }]  ([] = clear to send)
   */
  function contractGaps(f) {
    var x = f || {};
    var out = [];
    function gap(code, message) { out.push({ code: code, message: message }); }
    var cents = x.priceCents;
    if (carriesPrice(x.type) && !(typeof cents === 'number' && isFinite(cents) && cents > 0)) {
      gap('price', 'The contract price is blank or $0.00.');
    }
    if (_blank(x.address)) gap('address', 'The property address is blank.');
    if (_blank(x.homeownerName)) gap('homeownerName', 'The homeowner name is blank.');
    if (x.needsMailingAddress && _blank(x.mailingAddress)) {
      gap('mailingAddress', 'The company mailing address is not set (Company Profile, Mailing Address).');
    }
    if (_blank(x.entityName)) gap('entityName', 'The company legal entity name is not set (Company Profile).');
    if (String(x.type || '') === 'contract') {
      if (_blank(x.startDate)) gap('startDate', 'The start date is blank.');
      if (_blank(x.estimatedCompletion)) gap('estimatedCompletion', 'The estimated completion is blank.');
    }
    if (tooLarge(x.text)) gap('tooLarge', 'The document is too large to check (over 2 MB). Shorten it or remove embedded images, then try again.');
    placeholdersIn(x.text).forEach(function (tok) {
      gap('placeholder', 'The document still has a placeholder: ' + tok);
    });
    return out;
  }

  /** One rep-facing sentence for a list of gaps ('' when there are none). */
  function describeGaps(gaps) {
    if (!gaps || !gaps.length) return '';
    return 'This document cannot be sent or signed yet. ' + gaps.map(function (g) { return g.message; }).join(' ');
  }

  return {
    CONTRACT_CLASS: CONTRACT_CLASS.slice(),
    isContractClass: isContractClass,
    carriesPrice: carriesPrice,
    tooLarge: tooLarge,
    MAX_TEXT: MAX_TEXT,
    visibleText: visibleText,
    placeholdersIn: placeholdersIn,
    contractGaps: contractGaps,
    describeGaps: describeGaps
  };
});
