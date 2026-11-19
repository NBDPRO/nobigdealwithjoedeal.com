/**
 * attic-ack.js - the Attic, Ventilation & Moisture Acknowledgment (phase 3 of the template/liability
 * overhaul, 2026-11-18; flag docAtticAckV1, default OFF). Pure logic, no I/O:
 *
 *   scope           reroof | repair | siding | gutters | other (Q22), defaulted from the estimate's tear-off lines
 *   record          the rep's attic record on the job (status, reason, photos, numbers, conditions, recommendations)
 *   validate        Q69 photo minimums
 *   recommendations lines from config; a line with no price is HIDDEN (Q28)
 *   acknowledgments the tick controls in the generated HTML and how a signed copy is read back
 *   gate            a reroof contract needs the signed form, the signed not-inspected page or a recorded override (Q18)
 *   warranty line, free later check due date (Q17, Q71)
 *
 * The wording is attic-ack-text.js (copied from the attorney packet by script). ONE MODULE, TWO COPIES:
 * docs/pro/js/attic-ack.js (window.NBDAtticAck) and functions/attic-ack.js, pinned byte-identical after EOL
 * normalisation by tests/attic-ack-v1-2026-11-18.test.js. Edit this one, then copy it over.
 */
(function (root, factory) {
  var TXT = (typeof module === 'object' && module.exports) ? require('./attic-ack-text.js') : (root && root.NBDAtticAckText);
  var api = factory(TXT);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NBDAtticAck = api;
})(typeof window !== 'undefined' ? window : null, function (TXT) {
  'use strict';

  var FLAG = 'docAtticAckV1';
  var VERSION = 'ATTIC_ACK_V1';
  var DOC_TYPES = ['attic_acknowledgment', 'attic_not_inspected'];
  var SCOPES = ['reroof', 'repair', 'siding', 'gutters', 'other'];
  var SCOPE_LABELS = { reroof: 'Re-roof', repair: 'Repair', siding: 'Siding', gutters: 'Gutters', other: 'Other' };
  var STATUSES = ['inspected', 'not_inspected'];
  var REASONS = ['declined', 'scheduling_homeowner', 'scheduling_nbd', 'no_access', 'unsafe', 'no_attic', 'other'];
  // The packet's ATTIC-5 line each reason prints (the two scheduling reasons share one line and name whose schedule).
  var REASON_LINE = { declined: 0, scheduling_homeowner: 1, scheduling_nbd: 1, no_access: 2, unsafe: 3, no_attic: 4, other: 5 };
  // Who could not: a missed NBD visit is never written as the homeowner's choice.
  var REASON_WHO = { declined: 'homeowner', scheduling_homeowner: 'homeowner', scheduling_nbd: 'nbd', no_access: 'conditions', unsafe: 'conditions', no_attic: 'conditions', other: null };
  var CONDITION_KEYS = ['none', 'mold', 'water', 'frost', 'soft', 'daylight', 'fan', 'intake_blocked', 'low_intake', 'mixed_exhaust', 'animals', 'wiring', 'other'];
  var RULES = ['1/300', '1/150', 'code'];
  var ACCESS = ['hatch', 'pull-down stair', 'other'];

  // ── Scope (Q22) ──────────────────────────────────────────────────
  function _rows(est) {
    var e = est || {};
    return [].concat(Array.isArray(e.rows) ? e.rows : [], Array.isArray(e.lineItems) ? e.lineItems : []);
  }
  /** Does the estimate carry a tear-off labor line (catalog code "LAB TO...")? */
  function hasTearOff(est) {
    return _rows(est).some(function (r) { return r && /^LAB TO/i.test(String(r.code || r.id || '')); });
  }
  /** The default scope an estimate suggests. A rep may change it. */
  function scopeFromEstimate(est) {
    if (hasTearOff(est)) return 'reroof';
    var k = String((est && (est.workKind || est.kind)) || '').toLowerCase();
    if (k === 'repair') return 'repair';
    return 'other';
  }
  // Review 2026-11-18 (finding 1): a scope is only ever RAISED. The rep's stored scope is a floor, never a ceiling.
  var RANK = { other: 0, siding: 1, gutters: 1, repair: 2, reroof: 3 };
  function scopeRank(s) { return Object.prototype.hasOwnProperty.call(RANK, s) ? RANK[s] : 0; }
  function maxScope(list) {
    return (list || []).reduce(function (m, s) { return scopeRank(s) > scopeRank(m) ? s : m; }, 'other');
  }
  /**
   * The scope the gate reads: the MAXIMUM of the lead's stored scope (a floor the rep can raise, never lower), the server's
   * own floor (atticScopeFloor, written when a re-roof was seen), and the scope each estimate in play suggests. est is one
   * estimate or an array (the one being sent, the lead's primary, ...).
   */
  function effectiveScope(lead, est) {
    var ests = Array.isArray(est) ? est : [est];
    var c = ['other'];
    if (lead && typeof lead.scope === 'string' && SCOPES.indexOf(lead.scope) !== -1) c.push(lead.scope);
    if (lead && lead.atticScopeFloor === 'reroof') c.push('reroof');
    ests.forEach(function (e) { c.push(scopeFromEstimate(e)); });
    return maxScope(c);
  }
  function needsForm(scope) { return scope === 'reroof'; }

  // ── Photos and validation (Q69) ──────────────────────────────────
  function _photos(rec) { return Array.isArray(rec && rec.photos) ? rec.photos.filter(function (p) { return p && typeof p.id === 'string' && p.id; }) : []; }
  function _count(rec, kind) { return _photos(rec).filter(function (p) { return p.kind === kind; }).length; }
  function _blank(v) { return v == null || String(v).replace(/[\s ]+/g, '') === ''; }

  /** The problems that stop the record being used. [] = ok. Items: { code, message }. */
  function validate(rec) {
    var r = rec || {};
    var out = [];
    function bad(code, message) { out.push({ code: code, message: message }); }
    if (STATUSES.indexOf(r.status) === -1) { bad('status', 'Choose whether the attic was inspected or not.'); return out; }
    if (r.status === 'inspected') {
      if (_blank(r.inspectedOn)) bad('inspectedOn', 'Enter the date the attic was inspected.');
      if (_blank(r.accessPoint)) bad('accessPoint', 'Enter the access point (hatch, pull-down stair or other).');
      if (_count(r, 'overview') < 1) bad('photo_overview', 'Add at least one overview photo of the attic.');
      var ticked = r.conditions && typeof r.conditions === 'object' ? CONDITION_KEYS.filter(function (k) { return r.conditions[k] === true; }) : [];
      if (!ticked.length) bad('conditions', 'Tick what was seen, or "No visible concerns".');
      ticked.forEach(function (k) {
        if (k !== 'none' && _count(r, 'cond:' + k) < 1) bad('photo_' + k, 'Add a photo for "' + _conditionText(k) + '".');
      });
      if (r.conditions && r.conditions.other === true && _blank(r.conditionOther)) bad('conditionOther', 'Describe the "Other" condition.');
    } else {
      if (REASONS.indexOf(r.reason) === -1) bad('reason', 'Pick one reason the attic was not inspected.');
      else {
        if (r.reason === 'other' && _blank(r.reasonText)) bad('reasonText', 'Describe the other reason.');
        // Q69: no access and unsafe need one photo; declined and scheduling are a reason only.
        if ((r.reason === 'no_access' || r.reason === 'unsafe') && _count(r, 'access') < 1) bad('photo_access', 'Add one photo of the blocked or unsafe access.');
      }
    }
    return out;
  }

  // ── Wording ──────────────────────────────────────────────────────
  function _conditionText(k) {
    var i = CONDITION_KEYS.indexOf(k);
    return i < 0 || !TXT ? k : TXT.CONDITIONS[i].replace(/\*\*/g, '');
  }
  function _clean(s) { return String(s == null ? '' : s).replace(/\{\{\s*\}\}/g, '').replace(/\s+/g, ' ').trim(); }
  // The words NBD prints: another tenant's paper says "Contractor", never NBD's name (as clause-set.js does).
  function party(text, isNbd) { return isNbd === false ? String(text).replace(/\bNBD\b/g, 'Contractor') : String(text); }
  // "at least 3 days" is the packet's own number; it comes from config (atticFreeCheckDays) and a missing one stays a token.
  function days(text, terms) {
    var n = terms && terms.atticFreeCheckDays;
    var v = (typeof n === 'number' && isFinite(n) && n >= 1) ? String(n) : '{{atticFreeCheckDays}}';
    return String(text).replace(/(at least )3( days before the start date)/, '$1' + v + '$2');
  }
  function words(text, terms, isNbd) { return party(days(text, terms), isNbd); }
  /** The unset Company Profile numbers the acknowledgment prints (blocks the send, like clause-set.js). */
  function missingTerms(terms) {
    var n = terms && terms.atticFreeCheckDays;
    return (typeof n === 'number' && isFinite(n) && n >= 1) ? [] : ['atticFreeCheckDays'];
  }

  // ── Recommendations (Q28): a line with no price is hidden ────────
  // Prices in cents. null = not priced = the line does not print. NBD fills these from its estimate settings;
  // a deployment may override with NBD_ESTIMATE_CONFIG.atticRecommendationPrices { id: cents }.
  var REC_DEFS = [
    { id: 'ridge_vent', label: 0, unit: 'ft', per: 'unit', cents: null },
    { id: 'soffit_intake', label: 1, unit: null, per: 'flat', cents: null },
    { id: 'box_vents', label: 2, unit: null, per: 'flat', cents: null },
    { id: 'bath_fan_duct', label: 3, unit: null, per: 'flat', cents: null },
    { id: 'decking', label: 4, unit: 'sheets', per: 'unit', cents: null, fromTerms: 'deckingPerSheetCents' }
  ];
  function _int(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v > 0 ? v : null; }
  function _recLabel(def, qty) {
    var t = TXT ? TXT.REC_LABELS[def.label].replace(/^\{\{|\}\}$/g, '') : def.id;
    t = t.replace(/\bN\b/, String(qty == null ? '' : qty));
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  /**
   * The priced recommendation lines for a record. rec.recs = [{ id, qty }] the rep recommends; only lines with a
   * price print. Third-party lines (the packet's two "you arrange and pay them" rows) have no price by design and
   * always print. -> [{ id, label, qty, unit, priceCents, thirdParty }]
   */
  function recommendationLines(rec, terms, prices) {
    var P = prices && typeof prices === 'object' ? prices : {};
    var chosen = Array.isArray(rec && rec.recs) ? rec.recs : [];
    var out = [];
    REC_DEFS.forEach(function (def) {
      var pick = chosen.filter(function (c) { return c && c.id === def.id; })[0];
      if (!pick) return;
      var unit = _int(P[def.id]) || _int(def.cents) || (def.fromTerms ? _int(terms && terms[def.fromTerms]) : null);
      if (unit == null) return;   // no price: hidden
      var qty = def.per === 'unit' ? _int(Number(pick.qty)) : 1;
      if (def.per === 'unit' && qty == null) return;
      out.push({ id: def.id, label: _recLabel(def, def.per === 'unit' ? qty : null), qty: qty, unit: def.unit, priceCents: unit * qty, thirdParty: false });
    });
    if (TXT) TXT.RECS_THIRD_PARTY.forEach(function (label, i) { out.push({ id: 'third_party_' + (i + 1), label: label, qty: null, unit: null, priceCents: null, thirdParty: true }); });
    return out;
  }

  // ── Tick controls and reading a signed copy back ─────────────────
  // Generated HTML carries <input type=checkbox|radio data-nbd-ack="id" [data-nbd-required="1"]>. The signature widget
  // writes each control's state into a `checked` attribute at finalize; parseAcks reads that back, on the SERVER from
  // the stored copy, never from anything the browser claims.
  function parseAcks(html) {
    var out = [];
    var re = /<input\b/gi, m;
    var s = String(html == null ? '' : html);
    // Linear (review 2, item 2): the end of each tag is found with indexOf, and a tag with no '>' ends the scan, so a copy made of
    // thousands of unclosed '<input' cannot make every start rescan the rest of the document.
    while ((m = re.exec(s))) {
      var gt = s.indexOf('>', m.index);
      if (gt === -1) break;
      var tag = s.slice(m.index, gt + 1);
      re.lastIndex = gt + 1;
      var id = /\bdata-nbd-ack\s*=\s*"([^"]{1,80})"/i.exec(tag);
      if (!id) continue;
      out.push({
        id: id[1],
        type: /\btype\s*=\s*"radio"/i.test(tag) ? 'radio' : 'checkbox',
        required: /\bdata-nbd-required\s*=\s*"1"/i.test(tag),
        checked: /\schecked(?=[\s=>\/])/i.test(tag)
      });
      if (out.length >= 80) break;
    }
    return out;
  }
  function _group(id) { return String(id).replace(/:(yes|no)$/, ''); }
  /** Every required tick is ticked and every Yes/No line has exactly one answer. -> { ok, missing: [id] } */
  function acksComplete(list) {
    var a = Array.isArray(list) ? list : [];
    var missing = [];
    var groups = {};
    a.forEach(function (x) {
      if (x.type === 'radio') {
        var g = _group(x.id);
        groups[g] = (groups[g] || 0) + (x.checked ? 1 : 0);
      } else if (x.required && !x.checked) missing.push(x.id);
    });
    Object.keys(groups).forEach(function (g) { if (groups[g] !== 1) missing.push(g); });
    return { ok: missing.length === 0 && a.length > 0, missing: missing };
  }
  /** What goes in the evidence: [{ id, checked }] (a Yes/No line is two entries). */
  function evidenceAcks(list) {
    return (Array.isArray(list) ? list : []).slice(0, 80).map(function (x) { return { id: x.id, checked: x.checked === true }; });
  }
  /** Did the homeowner answer "No" to any ventilation recommendation? */
  function declinedAny(list) {
    return (Array.isArray(list) ? list : []).some(function (x) { return x.checked && /^rec:(?!third_party).+:no$/.test(x.id); });
  }

  // ── The gate (step 5) ────────────────────────────────────────────
  /**
   * x = { scope, signedForm: bool, override: bool }. A reroof needs the signed form (either document) or a recorded
   * owner/admin override (Q18). A repair is a warning only; siding, gutters and other print nothing.
   */
  function gate(x) {
    var s = x || {};
    if (!needsForm(s.scope)) return { required: false, satisfied: true, how: null, warn: s.scope === 'repair', message: '' };
    if (s.signedForm === true) return { required: true, satisfied: true, how: 'form', warn: false, message: '' };
    if (s.override === true) return { required: true, satisfied: true, how: 'override', warn: false, message: '' };
    return {
      required: true, satisfied: false, how: null, warn: false,
      message: 'A re-roof contract cannot be sent or signed until the Attic, Ventilation & Moisture Acknowledgment (or the signed "not inspected" page) is signed.'
    };
  }
  /** Is this lead documents row a signed attic form? (the same shape in-person-signing-logic.notSignedReason reads) */
  function isSignedForm(row) {
    var d = row || {};
    return DOC_TYPES.indexOf(String(d.type || '')) !== -1 && String(d.status || '') === 'signed' && !!d.signedAt;
  }

  // ── Warranty (step 6) and the free later check (step 7) ──────────
  /** Which signed attic result prints the warranty exclusion? { notInspected, declined } -> bool */
  function needsWarrantyExclusion(r) { var x = r || {}; return x.notInspected === true || x.declined === true; }
  function warrantyLine(formDateText) {
    return TXT ? String(TXT.WARRANTY_LINE).replace('{{form date}}', String(formDateText || '')) : '';
  }
  var DAY = 86400000;
  /** Q17/Q71: a check is offered when the homeowner declined or scheduling failed (either side). */
  function wantsFreeCheck(rec) {
    return !!rec && rec.status === 'not_inspected' && (rec.reason === 'declined' || rec.reason === 'scheduling_homeowner' || rec.reason === 'scheduling_nbd');
  }
  /** Due: `days` before the start date; with no start date, the contract date + 7 days. -> ms or null */
  function freeCheckDue(o) {
    var x = o || {};
    var d = typeof x.days === 'number' && isFinite(x.days) ? x.days : null;
    if (typeof x.startMs === 'number' && isFinite(x.startMs) && d != null) return x.startMs - d * DAY;
    if (typeof x.contractMs === 'number' && isFinite(x.contractMs)) return x.contractMs + 7 * DAY;
    return null;
  }

  // ── The form's own CSS (review 3, item 1) ─────────────────────────
  // The server holds the style blocks an attic form may carry (functions/attic-gate.js compares each <style> in a stored copy to these,
  // after white space is normalised, and rejects any other block). The generator reads the same constants, so the two cannot drift.
  // SIG_STYLES_CSS is the body of generate()'s <style id="nbd-sig-styles"> block (document-generator.js _injectSignatureAssets).
  // PRINT_RULE_CSS is the print rule that opens the page's own style block (document-generator-templates.js printCSS).
  // ATTIC_FORM_CSS is the body of the form's own <style> block (document-generator-library.js).
  var SIG_STYLES_CSS =
    '.nbd-sig-block{margin:0.2in 0 0.4in;padding:0;page-break-inside:avoid;}' +
    '.nbd-sig-label{font-size:11px;font-weight:700;color:#1A3057;margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em;}' +
    '.nbd-sig-canvas{display:block;width:100%;height:120px;border:1px dashed #999;border-radius:6px;background:#fafafa;cursor:crosshair;box-sizing:border-box;touch-action:none;}' +
    '.nbd-sig-img{display:block;max-width:100%;height:auto;background:#fff;border-bottom:1px solid #1A3057;padding-bottom:4px;}' +
    '.nbd-sig-controls{margin-top:6px;display:flex;gap:8px;align-items:center;}' +
    '.nbd-sig-controls button{font-size:11px;padding:4px 10px;background:#fff;border:1px solid #ccc;border-radius:4px;cursor:pointer;font-family:inherit;}' +
    '.nbd-sig-controls button:hover{background:#f5f5f5;}' +
    '.nbd-sig-state{font-size:10px;color:#2d7a2d;font-weight:600;margin-left:auto;}' +
    '.nbd-sig-date{margin-top:4px;font-size:10px;color:#666;font-style:italic;}' +
    '.nbd-sig-print-name{margin-top:8px;font-size:10px;color:#666;}' +
    '@media print{.nbd-sig-controls,.nbd-sig-state{display:none!important;}.nbd-sig-canvas{border:1px solid #333;background:#fff;}}';
  var PRINT_RULE_CSS = '@media print { .no-print { display:none!important; } body { margin:0; } @page { margin:0.5in; } }';
  var ATTIC_FORM_CSS = '.aa-p{font-size:13px;line-height:1.55;margin:0 0 9px;}.aa-ver{text-align:right;font-size:9px;color:#888;margin:0 0 6px;}' +
    '.aa-row{display:flex;gap:9px;align-items:flex-start;font-size:13px;line-height:1.5;margin:0 0 9px;}.aa-row input{margin-top:3px;flex:0 0 auto;width:18px;height:18px;}' +
    '.aa-sel{font-size:13px;line-height:1.5;margin:0 0 6px;}.aa-thumbs img{max-height:90px;max-width:130px;margin:4px 6px 0 0;border:1px solid #ccc;}' +
    '.aa-note{font-size:11px;color:#555;margin:0 0 10px;}.aa-opt{text-align:center;width:60px;}.aa-opt input{width:18px;height:18px;}';

  return {
    SIG_STYLES_CSS: SIG_STYLES_CSS, PRINT_RULE_CSS: PRINT_RULE_CSS, ATTIC_FORM_CSS: ATTIC_FORM_CSS,
    FLAG: FLAG, VERSION: VERSION, DOC_TYPES: DOC_TYPES, SCOPES: SCOPES, SCOPE_LABELS: SCOPE_LABELS, STATUSES: STATUSES,
    REASONS: REASONS, REASON_LINE: REASON_LINE, REASON_WHO: REASON_WHO, CONDITION_KEYS: CONDITION_KEYS, RULES: RULES, ACCESS: ACCESS,
    REC_DEFS: REC_DEFS, TEXT: TXT,
    hasTearOff: hasTearOff, scopeFromEstimate: scopeFromEstimate, effectiveScope: effectiveScope, scopeRank: scopeRank, maxScope: maxScope, needsForm: needsForm,
    validate: validate, words: words, party: party, missingTerms: missingTerms, clean: _clean,
    recommendationLines: recommendationLines, parseAcks: parseAcks, acksComplete: acksComplete, evidenceAcks: evidenceAcks,
    declinedAny: declinedAny, gate: gate, isSignedForm: isSignedForm, needsWarrantyExclusion: needsWarrantyExclusion,
    warrantyLine: warrantyLine, wantsFreeCheck: wantsFreeCheck, freeCheckDue: freeCheckDue
  };
});
