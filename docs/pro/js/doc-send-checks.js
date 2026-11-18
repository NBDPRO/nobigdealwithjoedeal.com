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

  // Visible text of a rendered document: no <script>/<style>, no tags.
  function visibleText(html) {
    return String(html == null ? '' : html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ');
  }

  // {{token}} and [Capitalised Words] (a template's "fill me in" marker). "[ ]" and
  // "[x]" checkboxes and lowercase brackets are not placeholders.
  var BRACE_RE = /\{\{[^{}]{1,60}\}\}/g;
  var BRACKET_RE = /\[[A-Z][A-Za-z0-9 #\/.'&-]{1,40}\]/g;

  /** The distinct placeholder tokens left in rendered text or HTML. */
  function placeholdersIn(htmlOrText) {
    var t = visibleText(htmlOrText);
    var found = [];
    (t.match(BRACE_RE) || []).concat(t.match(BRACKET_RE) || []).forEach(function (m) {
      if (found.indexOf(m) === -1) found.push(m);
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
    visibleText: visibleText,
    placeholdersIn: placeholdersIn,
    contractGaps: contractGaps,
    describeGaps: describeGaps
  };
});
