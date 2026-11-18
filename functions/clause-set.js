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
 * can never disagree. Phase 2 (flag docClauseSetV1) prints the v1 set from
 * clause-set-text.js through renderV1; the six clauses below are unchanged. Bump CLAUSE_SET_VERSION whenever a clause is added, removed or reworded.
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
  var node = typeof module === 'object' && module.exports;
  var law = node ? require('./ky-insurance-law') : (root && root.NBDJurisdiction);
  var text = node ? require('./clause-set-text') : (root && root.NBDClauseText);
  var api = factory(law || {}, text || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NBDClauseSet = api;
})(typeof window !== 'undefined' ? window : null, function (K, TX) {
  'use strict';

  var CLAUSE_SET_VERSION = 'CS-2026-11-18.2';

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

  // ───────────────────────── v1 clause set (phase 2, flag docClauseSetV1) ─────────────────────────
  // The wording is in clause-set-text.js. Statutory text is NEVER retyped: those clauses are 'byRef'
  // and the document prints the shipped module blocks exactly as before.
  var T = (TX && TX.CLAUSES) || {};

  // NBD's own numbers. A tenant never inherits these (paymentTermsFor). null = not set yet.
  var NBD_PAYMENT_TERMS_DEFAULTS = {
    lateGraceDays: 15, lateInterestPct: 8, disputeDays: 10, finalPaymentDays: 7, punchListDays: 3,
    pauseNoticeDays: 5, restockPct: 15, cardFeePct: 0, deckingPerSheetCents: null,
    deckingSheetsBeforeChangeOrder: 10, atticFreeCheckDays: 3, claimNoticeDays: 30
  };
  var PT_FIELDS = Object.keys(NBD_PAYMENT_TERMS_DEFAULTS);
  // Fields a printed clause needs, by clause id (cardFeePct 0 is a valid "off", so it is never "missing").
  var NEEDS = {
    'PAY-3': ['finalPaymentDays'], 'PAY-4': ['finalPaymentDays', 'punchListDays'], 'PAY-5': ['disputeDays'],
    'LATE-1': ['lateGraceDays', 'lateInterestPct'], 'LATE-6': ['pauseNoticeDays'], 'MAT-1': ['restockPct'],
    'CO-2': ['deckingPerSheetCents', 'deckingSheetsBeforeChangeOrder'], 'WAR-3': ['claimNoticeDays']
  };
  function _numOk(v) { return v !== null && v !== undefined && v !== '' && isFinite(Number(v)) && Number(v) >= 0; }

  /** The tenant's terms: its own fields only, over NBD's defaults for the NBD tenant only. */
  function paymentTermsFor(profileTerms, isNbd) {
    var own = profileTerms && typeof profileTerms === 'object' ? profileTerms : {};
    var out = {};
    PT_FIELDS.forEach(function (k) {
      out[k] = own[k] !== undefined && own[k] !== null && own[k] !== '' ? own[k] : (isNbd ? NBD_PAYMENT_TERMS_DEFAULTS[k] : null);
    });
    return out;
  }

  // Order, section titles and by-reference clauses of the printed set.
  var SECTIONS = [
    ['Terms of Payment', ['PAY-1', 'PAY-2', 'PAY-3', 'PAY-4', 'PAY-5', 'PAY-6', 'PAY-7', 'LATE-1', 'LATE-3', 'LATE-4', 'LATE-5', 'LATE-6']],
    ['Warranty Terms', ['WAR-1', 'WAR-2', 'WAR-3', 'WAR-4', 'WAR-5', 'WAR-6', 'WAR-7']],
    ['Change Orders and Hidden Conditions', ['CO-1', 'CO-2', 'CO-3']],
    ['Schedule, Access and Permits', ['SCH-1', 'SCH-2', 'SCH-3']],
    ['Materials, Special Orders and Restocking', ['MAT-1']],
    ['Insurance Jobs', ['INS-1', 'INS-2', 'INS-3', 'INS-4', 'INS-5']],
    ["Mechanic's Liens", ['LIEN-1', 'LIEN-2', 'LIEN-3', 'LIEN-4', 'LIEN-5']],
    ['Subcontractors', ['SUB-1']],
    ['Dispute Resolution and General Terms', ['DISP-1', 'DISP-3', 'DISP-4', 'DISP-6', 'DISP-8']],
    ['E-Signature, Contact and Photos', ['ESIGN-1', 'ESIGN-2', 'MEDIA-1']],
    ['Cancellation', ['CANC-1']]
  ];
  var BYREF = {
    'PAY-2': 'deposit rule', 'WAR-4': 'tier settings',
    'INS-1': 'PAYMENT', 'INS-3': 'KY notices', 'INS-4': 'KY notices and form', 'LIEN-3': 'KY lien sentence',
    'CANC-1': 'cancel packet'
  };
  var BYREF_PRINTS = { 'PAY-2': 'all', 'WAR-4': 'warranty', 'INS-1': 'ins', 'INS-3': 'ky_ins', 'INS-4': 'ky_ins', 'LIEN-3': 'ky_ins', 'CANC-1': 'all' };

  /** 'KY' or 'OH' (any other state reads as OH) and cash / insurance / financed, failing closed. */
  function variantOf(opts) {
    var o = opts || {};
    var st = _state(o.state), src = _source(o.paymentSource);
    var ky = st === 'KY' || st === '';
    var source = src === '' ? 'insurance' : src;
    return { state: ky ? 'KY' : 'OH', source: source, key: (ky ? 'KY' : 'OH') + '.' + source,
      ky: ky, ins: source === 'insurance', fin: source === 'financed', kyIns: ky && source === 'insurance',
      failClosed: st === '' || src === '' };
  }
  function _prints(rule, v, o) {
    switch (rule) {
      case 'all': return true;
      case 'non_ky': return !v.ky;
      case 'ky_noins': return v.ky && !v.ins;
      case 'ins': return v.ins;
      case 'ky_ins': return v.kyIns;
      case 'ins_or_fin': return v.ins || v.fin;
      case 'milestones': return !!(o.facts && o.facts.milestones && o.facts.milestones.length);
      case 'warranty': return o.hasWarranty !== false;
      default: return false;
    }
  }
  function _partOk(only, v, terms) {
    if (!only) return true;
    if (only === 'nbd') return true;
    if (only === 'ky') return v.ky;
    if (only === 'ky_ins') return v.kyIns;
    if (only === 'fin') return v.fin;
    if (only === 'cardfee') return Number(terms.cardFeePct) > 0 && !v.kyIns;
    return false;
  }
  function _money(c) {
    var n = Math.round(Number(c)), d = Math.floor(n / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return '$' + d + '.' + ('0' + (n % 100)).slice(-2);
  }
  var ENT_TOKEN = '{{entity}}';
  function _fill(text, terms, facts, party) {
    var s = text.replace(/\{\{cfg(\$?):([A-Za-z]+)\}\}/g, function (m, money, k) {
      if (!_numOk(terms[k])) return '{{' + k + '}}';
      return money ? _money(terms[k]) : String(terms[k]);
    });
    var f = facts || {};
    var ms = f.milestones && f.milestones.length ? f.milestones.join(', ') : null;
    if (ms) s = s.replace(TX.MILESTONES, ms);
    s = s.split('{{owner name(s)}}').join(f.ownerNames == null ? '{{owner name(s)}}' : f.ownerNames)
      .split('{{property address}}').join(f.propertyAddress == null ? '{{property address}}' : f.propertyAddress)
      .split('{{date}}').join(f.date == null ? '{{date}}' : f.date)
      .split('{{company phone}}').join(f.companyPhone || '{{company phone}}')
      .split(ENT_TOKEN).join(party && party.entity ? party.entity : ENT_TOKEN);
    // A tenant's paper never names NBD: the defined term becomes "Contractor".
    if (party && !party.isNbd) s = s.replace(/\bNBD\b/g, 'Contractor');
    return s;
  }

  /** The party block: names and the signature line, from the brand (no NBD names for another tenant). */
  function partyFor(brand, isNbd) {
    var b = brand || {};
    var entity = String(b.entityName || '').trim() || (isNbd ? 'No Big Deal Solutions LLC' : String(b.legalName || '').trim());
    var dba = String(b.dbaName || '').trim() || (isNbd ? 'No Big Deal Home Solutions' : '');
    var title = String(b.signerTitle || '').trim() || (isNbd ? 'Manager' : '');
    var signer = isNbd ? 'Joe Deal' : '';
    var nameLine = dba && dba !== entity ? entity + ' d/b/a ' + dba : entity;
    var by = 'By: ' + (signer ? signer : '______________') + (title ? ', ' + title : '');
    return { isNbd: !!isNbd, entity: entity, dba: dba, signer: signer, signerTitle: title, nameLine: nameLine, byLine: by, signerLabel: nameLine + ' - ' + by };
  }

  /**
   * The v1 set for one document. opts = { state, paymentSource, terms (paymentTermsFor), facts, party, hasWarranty }
   * -> { clauseSetVersion, variant, failClosed, refs: ['PAY-4_V1', ...], missing: [field], sections:
   *      [{ title, items: [{ id, ref, byRef, paragraphs: [text] }] }], sectionOf: {id: title} }
   */
  function renderV1(opts) {
    // Fail closed (review 2026-11-18, item 5): with no wording table the set would silently print nothing and the
    // legacy sections it replaces would be gone. A caller must never get an empty set back.
    if (!T || !Object.keys(T).length) throw new Error('clause wording did not load');
    var o = opts || {};
    var v = variantOf(o);
    var terms = o.terms || {};
    var party = o.party || null;
    var refs = [], missing = [], sections = [];
    function note(id, need) {
      (need || []).forEach(function (k) {
        var bad = k === 'deckingPerSheetCents' ? !_numOk(terms[k]) || Number(terms[k]) <= 0 : !_numOk(terms[k]);
        if (bad && missing.indexOf(k) === -1) missing.push(k);
      });
    }
    var partyClause = T['PARTY-1'];
    var partyItem = null;
    if (partyClause) {
      var wantNbd = party ? !!party.isNbd : true;
      var pp = partyClause.parts.filter(function (p) { return p.only === (wantNbd ? 'nbd' : 'tenant'); })[0];
      partyItem = { id: 'PARTY-1', ref: 'PARTY-1_V1', byRef: false, paragraphs: [_fill(pp.text, terms, o.facts, party)] };
      refs.push(partyItem.ref);
    }
    SECTIONS.forEach(function (sec) {
      var items = [];
      sec[1].forEach(function (id) {
        var c = T[id], item = null;
        if (BYREF[id] !== undefined) {
          if (_prints(BYREF_PRINTS[id], v, o)) item = { id: id, ref: id + '_V1', byRef: true, paragraphs: [] };
        } else if (c && _prints(c.prints, v, o)) {
          var paras = [];
          c.parts.forEach(function (p) { if (_partOk(p.only, v, terms)) paras.push(_fill(p.text, terms, o.facts, party)); });
          if (paras.length) { item = { id: id, ref: id + '_V' + c.version, byRef: false, paragraphs: paras }; note(id, NEEDS[id]); }
        }
        if (item) { items.push(item); refs.push(item.ref); }
      });
      if (items.length) sections.push({ title: sec[0], items: items });
    });
    return { clauseSetVersion: CLAUSE_SET_VERSION, variant: v.key, failClosed: v.failClosed, refs: refs, missing: missing, party: partyItem, partyBlock: party, sections: sections };
  }

  /** The fields a document of this kind still needs from Company Profile (empty = ready). */
  function missingConfig(opts) { return renderV1(opts).missing; }

  /** describeFor for a document that prints the v1 set: the legacy statutory refs plus every v1 ref. */
  function describeV1(opts) {
    var base = describeFor(opts);
    var r = renderV1(opts);
    var have = {};
    var clauses = base.clauses.slice();
    clauses.forEach(function (c) { have[c.ref] = true; });
    r.refs.forEach(function (ref) {
      if (have[ref]) return;
      var m = /^(.*)_V(\d+)$/.exec(ref);
      clauses.push({ id: m[1], version: Number(m[2]), ref: ref });
    });
    return { clauseSetVersion: CLAUSE_SET_VERSION, state: base.state, paymentSource: base.paymentSource, failClosed: base.failClosed, clauses: clauses };
  }

  return {
    CLAUSE_SET_VERSION: CLAUSE_SET_VERSION,
    VARIANTS: VARIANTS.slice(),
    REGISTRY: REGISTRY,
    describeFor: describeFor,
    textFor: textFor,
    all: all,
    NBD_PAYMENT_TERMS_DEFAULTS: NBD_PAYMENT_TERMS_DEFAULTS,
    PT_FIELDS: PT_FIELDS,
    paymentTermsFor: paymentTermsFor,
    variantOf: variantOf,
    partyFor: partyFor,
    renderV1: renderV1,
    missingConfig: missingConfig,
    describeV1: describeV1,
    V1_IDS: Object.keys(T).concat(Object.keys(BYREF)).filter(function (x, i, a) { return a.indexOf(x) === i; })
  };
});
