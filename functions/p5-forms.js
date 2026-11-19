/**
 * p5-forms.js - the phase 5 documents (Jo, 2026-11-19; flag docClauseSetV1, default OFF): the data and wording the
 * generator (document-generator-library.js) and the server (functions/attic-gate.js, the signing paths) share.
 *
 *   property_condition          Property Condition & Access Acknowledgment (pre-job walk-through)
 *   decking_authorization       Hidden Conditions / Decking Authorization
 *   emergency_services_request  Emergency Services Request (homeowner only)
 *   final_walkthrough           Final Walkthrough & Punch List sign-off
 *   ohio_insurance_ack          Ohio Insurance Job Acknowledgment
 *
 * WORDING. Registry clauses (clause-set-text.js: SCH-1, SCH-2, CO-2, CO-3, PAY-4, INS-2, INS-5, DISP-6, MEDIA-1, and
 * the INS-1 payment clause by reference) are printed by the renderer from the registry, never retyped. The strings in
 * TEXT below are NEW and are the drafter's: every one is plain and neutral, and every one is listed in
 * documentation/projects/PHASE5-TEMPLATES-2026-11-18.md under "Drafter wording". // DRAFTER WORDING: attorney to confirm
 *
 * ONE MODULE, TWO COPIES (like attic-ack.js): docs/pro/js/p5-forms.js and functions/p5-forms.js, pinned byte-identical
 * after EOL normalisation by tests/phase5-templates-server-2026-11-19.test.js. Edit this one, then copy it over.
 */
(function (root, factory) {
  var node = typeof module === 'object' && module.exports;
  var AA = node ? require('./attic-ack') : (root && root.NBDAtticAck);
  var CT = node ? require('./clause-set-text') : (root && root.NBDClauseText);
  var api = factory(AA || {}, CT || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NBDP5Forms = api;
})(typeof window !== 'undefined' ? window : null, function (AA, CT) {
  'use strict';

  var FLAG = 'docClauseSetV1';
  var VERSION = 'P5_FORMS_V1';
  var TYPES = ['property_condition', 'decking_authorization', 'emergency_services_request', 'final_walkthrough', 'ohio_insurance_ack'];

  // DRAFTER WORDING: attorney to confirm (every string in this block)
  var TEXT = {
    PARTY: '{{contractor}} ("Contractor") and {{owner}}, the owner(s) of the property at {{address}}, sign this form.',
    TICK_NOTE: 'Tick each box. Your ticks are saved with your signature.',
    NAMES: {
      property_condition: 'Property Condition & Access Acknowledgment',
      decking_authorization: 'Hidden Conditions / Decking Authorization',
      emergency_services_request: 'Emergency Services Request',
      final_walkthrough: 'Final Walkthrough & Punch List',
      ohio_insurance_ack: 'Ohio Insurance Job Acknowledgment'
    },
    // property_condition
    PC_INTRO: 'Before work starts, we walked the items below with you. Your representative noted what was there. Tick each item to confirm the note is right.',
    PC_NOTICE: 'I have read the notice above about access, utilities, and items inside and outside the home.',
    PC_ITEMS: {
      driveway: 'Driveway and walkways',
      landscaping: 'Landscaping, plants and fences near the house',
      gutters: 'Gutters and downspouts',
      satellite_dish: 'Satellite dish or antenna',
      solar: 'Solar panels',
      skylights: 'Skylights',
      wall_items: 'Items hanging on interior walls',
      attic_items: 'Items stored in the attic',
      ceilings: 'Interior ceilings (existing cracks and nail pops)',
      pets: 'Pets',
      utilities: 'Power and water',
      parking: 'Parking for the crew and the dumpster'
    },
    PC_NOTE_NONE: 'No note.',
    PC_PHOTOS: 'Photos on file:',
    // decking_authorization
    TICK_NOTE_LINE: 'Tick the box and choose Approve or Decline. Your answers are saved with your signature.',
    DK_INTRO: 'This form records what was found when the old roof came off, and whether you approve replacing it.',
    DK_READ: 'I have read the notice above and seen the photos listed.',
    DK_FOUND: 'Found on', DK_WHERE: 'Where', DK_SHEETS: 'Sheets to replace', DK_PRICE: 'Price per sheet', DK_TOTAL: 'Total for these sheets',
    DK_PHOTOS: 'Photos on file:',
    DK_YES: 'Approve replacing these sheets at the price shown.', DK_NO: 'Decline.'
  };

  var PC_KEYS = ['driveway', 'landscaping', 'gutters', 'satellite_dish', 'solar', 'skylights', 'wall_items', 'attic_items', 'ceilings', 'pets', 'utilities', 'parking'];

  // Per type (and variant): the registry clauses it prints, the tick ids that are required, and the Yes/No lines.
  var SPECS = {
    property_condition: {
      refs: ['SCH-2', 'DISP-6', 'MEDIA-1'],
      variants: { base: { required: ['ack:pc_notice'].concat(PC_KEYS.map(function (k) { return 'ack:pc_' + k; })), lines: [] } },
      statics: ['PC_INTRO', 'PC_NOTICE', 'TICK_NOTE']
    },
    decking_authorization: {
      refs: ['CO-2'],
      variants: { base: { required: ['ack:decking_read'], lines: ['decking'] } },
      statics: ['DK_INTRO', 'DK_READ', 'TICK_NOTE_LINE']
    }
  };

  function isP5Doc(type) { return TYPES.indexOf(String(type || '')) !== -1 && Object.prototype.hasOwnProperty.call(SPECS, String(type)); }
  function spec(type, variant) {
    var s = SPECS[type];
    if (!s) return null;
    var v = s.variants[variant || 'base'];
    return v ? { refs: s.refs.slice(), required: v.required.slice(), lines: v.lines.slice(), variant: variant || 'base' } : null;
  }

  var MARKER_RE = /<!--\s*nbd:p5\s+(\S+)\s+([a-z_]+)\s+([a-z_]+)\s+([A-Za-z0-9_,-]*)\s*-->/g;
  function marker(type, variant, refs) {
    return '<!-- nbd:p5 ' + VERSION + ' ' + type + ' ' + (variant || 'base') + ' ' + (refs || []).map(function (r) { return r + '_V1'; }).join(',') + ' -->';
  }

  // The form's own style block: the attic form's block plus layout-only rules (colours come from the page's brand block).
  // functions/attic-gate.js accepts a stored form's style block only when it equals this constant.
  var FORM_CSS = (AA.ATTIC_FORM_CSS || '') +
    '.lib-h1{text-align:center;font-size:24px;letter-spacing:.04em;text-transform:uppercase;margin:22px 0 4px;}' +
    '.lib-sub{text-align:center;font-size:13px;margin:0 0 18px;}.lib-fine{font-size:11px;line-height:1.5;}' +
    '.p5-item{border-bottom:1px solid #dfe2e7;padding:6px 0 4px;}.p5-note{font-size:12px;margin:0 0 6px 27px;}' +
    '.p5-kv{margin:0 0 14px;font-size:13px;}.p5-kv div{display:flex;flex-wrap:wrap;gap:6px 14px;padding:3px 0;}' +
    '.p5-kv dt{flex:0 0 190px;font-weight:700;}.p5-kv dd{margin:0;flex:1 1 200px;}' +
    '@media (max-width:600px){.p5-kv dt{flex:1 1 100%;}}';

  /** The static text runs (20+ characters) of a registry clause: what the server requires to find in a stored copy. */
  function runs(text) {
    return String(text == null ? '' : text).split('[ ]')[0].split(/\{\{[^}]*\}\}/).map(function (r) { return r.replace(/\*\*/g, '').replace(/\bNBD\b/g, 'Contractor').replace(/\s+/g, ' ').trim(); })
      .filter(function (r) { return r.length >= 20; });
  }
  /** Every wording fragment a stored copy of this type must carry (registry runs and this module's own static strings). */
  function fragments(type) {
    var s = SPECS[type];
    if (!s) return [];
    var out = [];
    var CL = (CT && CT.CLAUSES) || {};
    s.refs.forEach(function (id) {
      var c = CL[id];
      if (c && c.parts) c.parts.forEach(function (p) { if (!p.only) runs(p.text).forEach(function (r) { out.push(r); }); });
    });
    (s.statics || []).forEach(function (k) { runs(TEXT[k]).forEach(function (r) { out.push(r); }); });
    return out;
  }

  return {
    FLAG: FLAG, VERSION: VERSION, TYPES: TYPES, TEXT: TEXT, PC_KEYS: PC_KEYS, FORM_CSS: FORM_CSS, MARKER_RE: MARKER_RE,
    isP5Doc: isP5Doc, spec: spec, marker: marker, fragments: fragments, runs: runs
  };
});
