/**
 * clause-set.js — the versioned registry of the legal clauses a document carries
 * (Jo, 2026-11-18, template/liability overhaul, phase 1: evidence and clause
 * foundation).
 *
 * WHAT IT IS. A small lookup: clause id -> { id, version, ref, text per variant },
 * plus describeFor({ state, paymentSource }) which names the clauses (id +
 * version) a document of that kind carries today. A signed record stamps the
 * answer (CLAUSE_SET_VERSION + the refs) so "which wording was in force" stops
 * depending on a mutable company profile.
 *
 * WHAT IT IS NOT. It holds NO new wording. Every text below is read from
 * ky-insurance-law.js (the statutory text and the one Payment clause), never
 * retyped, so a template that already prints these sentences and this registry
 * can never disagree. Phase 2 adds clauses here; nothing prints from this file
 * yet. Bump CLAUSE_SET_VERSION whenever a clause is added, removed or reworded.
 *
 * ONE MODULE, TWO COPIES (same pattern as ky-insurance-law.js). The browser
 * loads docs/pro/js/clause-set.js (window.NBDClauseSet, after
 * ky-insurance-law.js); Cloud Functions require functions/clause-set.js
 * (functions/ deploys on its own and cannot reach docs/). The test pins the two
 * byte-identical after EOL normalisation: edit this one, then copy it over.
 *
 * FAIL CLOSED. An unreadable state, or an unknown payment source, gets the
 * stricter set (Kentucky, insurance), exactly as ky-insurance-law.js classify()
 * does: the extra notices cost nothing on another state's paper, their absence
 * can void a Kentucky contract.
 */
(function (root, factory) {
  var law = (typeof module === 'object' && module.exports) ? require('./ky-insurance-law') : (root && root.NBDJurisdiction);
  var api = factory(law || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NBDClauseSet = api;
})(typeof window !== 'undefined' ? window : null, function (K) {
  'use strict';

  var CLAUSE_SET_VERSION = 'CS-2026-11-18.1';

  // Variants a clause can apply under. 'all' = every contract; 'ky' = Kentucky or
  // an unreadable state; 'ky_insurance' = Kentucky (or unreadable) AND insurance
  // (or an unknown payment source).
  var VARIANTS = ['all', 'ky', 'ky_insurance'];

  function clause(id, version, variant, text) {
    var t = {};
    t[variant] = typeof text === 'string' ? text : '';
    return { id: id, version: version, ref: id + '_V' + version, variant: variant, text: t };
  }

  // Order is the order describeFor lists them in.
  var REGISTRY = {
    PAYMENT: clause('PAYMENT', 1, 'all', K.PAYMENT_CLAUSE),
    FTC_COOLING_OFF: clause('FTC_COOLING_OFF', 1, 'all', K.FTC_STATEMENT),
    KY_HOME_SOLICITATION: clause('KY_HOME_SOLICITATION', 1, 'ky', K.KY_HSSA_TEXT),
    KY_INS_NOTICE_CANCEL: clause('KY_INS_NOTICE_CANCEL', 1, 'ky_insurance', K.KY_NOTICE_CANCEL),
    KY_INS_NOTICE_NO_ASSIGNMENT: clause('KY_INS_NOTICE_NO_ASSIGNMENT', 1, 'ky_insurance', K.KY_NOTICE_NO_ASSIGNMENT),
    KY_INS_LIEN: clause('KY_INS_LIEN', 1, 'ky_insurance', K.KY_LIEN_CLAUSE)
  };

  function _state(s) {
    var v = String(s == null ? '' : s).trim().toUpperCase();
    if (v === 'KENTUCKY') return 'KY';
    if (v === 'OHIO') return 'OH';
    return /^[A-Z]{2}$/.test(v) ? v : '';
  }

  function _source(s) {
    var v = String(s == null ? '' : s).trim().toLowerCase();
    if (v === 'cash') return 'cash';
    if (v === 'insurance') return 'insurance';
    if (v === 'financed' || v === 'finance' || v === 'financing') return 'financed';
    return '';
  }

  /**
   * The clauses a document of this kind carries.
   * -> { clauseSetVersion, state, paymentSource, failClosed, clauses: [{ id, version, ref }] }
   * state / paymentSource come back normalised ('' = unreadable, which selected
   * the stricter set: failClosed true).
   */
  function describeFor(opts) {
    var o = opts || {};
    var state = _state(o.state);
    var source = _source(o.paymentSource);
    var ky = state === 'KY' || state === '';
    var insurance = source === 'insurance' || source === '';
    var live = { all: true, ky: ky, ky_insurance: ky && insurance };
    var clauses = [];
    Object.keys(REGISTRY).forEach(function (k) {
      var c = REGISTRY[k];
      if (live[c.variant]) clauses.push({ id: c.id, version: c.version, ref: c.ref });
    });
    return {
      clauseSetVersion: CLAUSE_SET_VERSION,
      state: state,
      paymentSource: source,
      failClosed: state === '' || source === '',
      clauses: clauses
    };
  }

  /** The registered text of one clause ('' when the id or variant is unknown). */
  function textFor(id, variant) {
    var c = Object.prototype.hasOwnProperty.call(REGISTRY, id) ? REGISTRY[id] : null;
    return c && typeof c.text[variant] === 'string' ? c.text[variant] : '';
  }

  /** Every registered clause as { id, version, ref, variant, text }. */
  function all() {
    return Object.keys(REGISTRY).map(function (k) {
      var c = REGISTRY[k];
      return { id: c.id, version: c.version, ref: c.ref, variant: c.variant, text: c.text[c.variant] };
    });
  }

  return {
    CLAUSE_SET_VERSION: CLAUSE_SET_VERSION,
    VARIANTS: VARIANTS.slice(),
    REGISTRY: REGISTRY,
    describeFor: describeFor,
    textFor: textFor,
    all: all
  };
});
