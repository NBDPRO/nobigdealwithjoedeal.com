/**
 * contact-labels-logic.js — the per-number label registry, PURE (2026-10-12).
 *
 * Jo (2026-10-12): "label each contact there and decide - continue screening
 * this number's calls / tag contractor / sub / customer / personal". Design:
 * documentation/projects/CONTACT-ROUTING-TREE-2026-10-12.md.
 *
 * One record per normalized 10-digit number per company
 * (companies/{companyId}/contact_labels/{digits10}):
 *   kind    what the number IS      (KINDS)
 *   policy  what the CRM does with its calls (POLICIES):
 *             surface — normal "needs you" rules: keep it on Today so Jo decides
 *             quiet   — counts only when Jo promised something on a call
 *             hide    — never counts (still listed in the Call Center)
 *
 * Nothing here touches the DOM, Firestore or the clock. contact-labels.js
 * (data + sheet) and home-attention.js (callNeedsYou reads the same shape
 * inline — it is eager, this file is a lazy bundle) build on it.
 *
 * A label never sends anything to anybody, never edits a lead and never
 * changes carrier forwarding: it only decides what SURFACES.
 */
(function (root) {
  'use strict';

  var KINDS = ['customer', 'prospect', 'contractor', 'sub', 'supplier', 'insurance', 'referral', 'personal', 'spam', 'recruiter', 'other'];
  var POLICIES = ['surface', 'quiet', 'hide'];
  // The seven chips the sheet shows first; the rest sit behind "More".
  var PRIMARY_KINDS = ['customer', 'sub', 'supplier', 'insurance', 'personal', 'spam', 'recruiter'];
  var KIND_LABEL = {
    customer: 'Customer', prospect: 'Prospect', contractor: 'Contractor', sub: 'Sub', supplier: 'Supplier',
    insurance: 'Adjuster / carrier', referral: 'Referral partner', personal: 'Personal', spam: 'Spam',
    recruiter: 'Job seeker', other: 'Other',
  };
  var POLICY_LABEL = { surface: 'Keep on Today so I decide', quiet: 'Only if I promised', hide: 'Stop surfacing' };
  // quiet reproduces today's sub / supplier behaviour (counted through a
  // promise only); hide is for people Jo never wants on the list.
  var DEFAULT_POLICY = {
    customer: 'surface', prospect: 'surface', contractor: 'quiet', sub: 'quiet', supplier: 'quiet',
    insurance: 'surface', referral: 'surface', personal: 'hide', spam: 'hide', recruiter: 'quiet', other: 'surface',
  };
  var SOURCES = ['manual', 'seed-tag', 'thursday', 'lead'];
  var NAME_MAX = 80, NOTE_MAX = 200;
  // The only keys a label doc may carry (firestore.rules hasOnly mirrors it).
  var DOC_KEYS = ['digits', 'kind', 'policy', 'name', 'note', 'source', 'companyId', 'updatedBy', 'updatedAtMs', 'createdAtMs', 'ackAtMs', 'capture'];

  function digits10(v) {
    var d = String(v == null ? '' : v).replace(/\D/g, '');
    if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
    return d.length === 10 ? d : '';
  }
  function isKind(k) { return KINDS.indexOf(k) !== -1; }
  function isPolicy(p) { return POLICIES.indexOf(p) !== -1; }
  function defaultPolicy(kind) { return DEFAULT_POLICY[kind] || 'surface'; }
  function clip(s, n) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n); }

  /**
   * A label doc ready to write, or null when kind / digits are not valid.
   * policy falls back to the kind's default when absent or not an enum value.
   */
  function buildDoc(o) {
    o = o || {};
    var d = digits10(o.digits);
    if (!d || !isKind(o.kind) || !o.companyId || !o.uid) return null;
    var now = Number(o.nowMs) || Date.now();
    var doc = {
      digits: d,
      kind: o.kind,
      policy: isPolicy(o.policy) ? o.policy : defaultPolicy(o.kind),
      name: clip(o.name, NAME_MAX),
      note: clip(o.note, NOTE_MAX),
      source: SOURCES.indexOf(o.source) !== -1 ? o.source : 'manual',
      companyId: String(o.companyId),
      updatedBy: String(o.uid),
      updatedAtMs: now,
      createdAtMs: Number(o.createdAtMs) || now,
    };
    // ackAtMs: Jo said "keep it hidden" after a hidden number came back (safety valve).
    if (Number(o.ackAtMs) > 0) doc.ackAtMs = Number(o.ackAtMs);
    // capture 'off' (personal only): Jo confirmed "stop copying and
    // transcribing future calls and texts from this number". Never inferred,
    // never carried over to another kind.
    if (o.capture === 'off' && o.kind === 'personal') doc.capture = 'off';
    return doc;
  }

  /** Firestore docs [{id, data}] → { digits10: label }; malformed docs are dropped. */
  function indexLabels(docs) {
    var out = {};
    (docs || []).forEach(function (r) {
      var data = (r && (r.data || r)) || {};
      var d = digits10((r && r.id) || data.digits);
      if (!d || !isKind(data.kind)) return;
      out[d] = {
        digits: d, kind: data.kind, policy: isPolicy(data.policy) ? data.policy : defaultPolicy(data.kind),
        name: clip(data.name, NAME_MAX), note: clip(data.note, NOTE_MAX),
        source: SOURCES.indexOf(data.source) !== -1 ? data.source : 'manual',
        updatedBy: data.updatedBy || '', updatedAtMs: Number(data.updatedAtMs) || 0,
        createdAtMs: Number(data.createdAtMs) || 0, ackAtMs: Number(data.ackAtMs) || 0,
        capture: data.kind === 'personal' && data.capture === 'off' ? 'off' : '',
      };
    });
    return out;
  }

  function lookup(labels, digits) {
    var d = digits10(digits);
    if (!labels || !d) return null;
    return (typeof labels.get === 'function' ? labels.get(d) : labels[d]) || null;
  }
  function policyOf(label) {
    if (!label) return 'surface';
    return isPolicy(label.policy) ? label.policy : defaultPolicy(label.kind);
  }

  /** Would this label keep the call off the list? promised = Jo made a promise on it. */
  function suppresses(label, promised) {
    var p = policyOf(label);
    if (p === 'hide') return true;
    if (p === 'quiet') return !promised;
    return false;
  }
  /** A number Jo labeled an adjuster is an insurance call even with no carrier name on the contact. */
  function effectiveBucket(label, bucket) {
    return label && label.kind === 'insurance' ? 'insurance' : bucket;
  }

  /** The chip a row shows: { text, tone } or null. tone: neutral | quiet | hidden. */
  function chipFor(label) {
    if (!label) return null;
    var p = policyOf(label);
    return {
      // A hidden number that still shows (a promise or an urgent call) says so.
      text: (KIND_LABEL[label.kind] || 'Labeled') + (p === 'hide' ? ' · hidden number' : '') + (label.capture === 'off' ? ' · not recorded' : ''),
      tone: p === 'hide' ? 'hidden' : p === 'quiet' ? 'quiet' : 'neutral',
      title: (KIND_LABEL[label.kind] || 'Labeled') + ' — ' + POLICY_LABEL[p],
    };
  }

  /**
   * A Cube ACR contact-name tag as a SUGGESTION (never auto-applied): returns
   * a kind that never hides anything, or null.
   */
  function seedKindFromTags(tags) {
    var t = tags || [];
    if (t.indexOf('sub') !== -1) return 'sub';
    if (t.indexOf('vendor') !== -1) return 'supplier';
    if (t.indexOf('referral') !== -1) return 'referral';
    if (t.indexOf('customer') !== -1) return 'customer';
    return null;
  }

  /**
   * Can this number be labeled `kind`? Refuses a number that identifies
   * nobody (a proxy on 3+ leads can't be a customer) or that is the
   * company's own line.
   *   o.ownDigits     [10-digit]  Thursday line, CRM sender, Jo's own
   *   o.leadCount     how many (non-deleted) leads carry the number
   */
  function checkTarget(digits, kind, o) {
    o = o || {};
    var d = digits10(digits);
    if (!d) return { ok: false, reason: 'No usable phone number on this row.' };
    if (!isKind(kind)) return { ok: false, reason: 'Pick what this number is.' };
    if ((o.ownDigits || []).map(digits10).indexOf(d) !== -1) return { ok: false, reason: 'That is your own number.' };
    if ((kind === 'customer' || kind === 'prospect') && Number(o.leadCount) >= 3) {
      return { ok: false, reason: 'This number is on 3 or more customers (a shared or proxy line) — it identifies nobody.' };
    }
    return { ok: true, reason: '' };
  }

  var API = {
    KINDS: KINDS, POLICIES: POLICIES, PRIMARY_KINDS: PRIMARY_KINDS, KIND_LABEL: KIND_LABEL, POLICY_LABEL: POLICY_LABEL,
    DEFAULT_POLICY: DEFAULT_POLICY, SOURCES: SOURCES, DOC_KEYS: DOC_KEYS, NAME_MAX: NAME_MAX, NOTE_MAX: NOTE_MAX,
    digits10: digits10, isKind: isKind, isPolicy: isPolicy, defaultPolicy: defaultPolicy,
    buildDoc: buildDoc, indexLabels: indexLabels, lookup: lookup, policyOf: policyOf,
    suppresses: suppresses, effectiveBucket: effectiveBucket, chipFor: chipFor,
    seedKindFromTags: seedKindFromTags, checkTarget: checkTarget,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root && root.document) root.NBDContactLabelsLogic = API;
})(typeof window !== 'undefined' ? window : null);
