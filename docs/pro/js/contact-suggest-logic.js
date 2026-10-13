/**
 * contact-suggest-logic.js — the label SUGGESTION engine, PURE (2026-10-12,
 * phase 2b). documentation/projects/CONTACT-ROUTING-TREE-2026-10-12.md.
 *
 * Jo: "YES to suggestions with one- or two-tap confirm, everywhere sensible.
 * Each suggestion is a chip with Accept / Not this (per-number dismiss,
 * remembered). Never auto-apply a kind that hides."
 *
 * Evidence, strongest first (one suggestion per number, the strongest wins):
 *   tag       the phone contact's "NBD Sub / Vendor / Referral / Customer" tag
 *   thursday  Thursday's caller_type on a call from that number
 *   calltype  the AI callType of the last two noted calls agree
 *   lead      the number is on a customer (lowest: only a hint, nothing hides)
 *   pattern   3+ calls in 14 days from an unlabeled unknown number, none noted
 *             (no kind is guessed: Accept opens the sheet)
 *
 * Rules:
 *   - never for a number that already has a label;
 *   - never for a (number, kind) Jo dismissed — unless NEW evidence of a
 *     DIFFERENT kind appears;
 *   - a kind whose default policy is `hide` (personal, spam) is never applied
 *     by one tap: needs.sheet = true, Accept opens the Label sheet with the
 *     kind picked and the policy left for Jo to choose;
 *   - never auto-applied by anything — this file only RANKS and WORDS them.
 * Nothing here touches the DOM, Firestore or the clock.
 */
(function (root) {
  'use strict';

  var LG = (typeof module !== 'undefined' && module.exports) ? require('./contact-labels-logic.js') : root.NBDContactLabelsLogic;
  var DAY = 86400000;
  var MAX_VISIBLE = 3;
  var PATTERN_CALLS = 3, PATTERN_DAYS = 14;
  // Strongest first.
  var RANK = { tag: 0, thursday: 1, calltype: 2, lead: 3, pattern: 4 };
  var THURSDAY_KIND = { supplier_sub: 'supplier', adjuster: 'insurance', job_seeker: 'recruiter', spam: 'spam' };
  var CALLTYPE_KIND = { sub: 'sub', supplier: 'supplier', insurance: 'insurance', spam: 'spam' };
  // label doc `source` for each evidence kind (rules enum: manual, seed-tag, thursday, lead, pattern)
  var SOURCE_OF = { tag: 'seed-tag', thursday: 'thursday', calltype: 'pattern', lead: 'lead', pattern: 'pattern' };
  var WHY = {
    tag: function (k) { return 'your phone contact is tagged "' + ({ sub: 'NBD Sub', supplier: 'NBD Vendor', referral: 'NBD Referral', customer: 'NBD Customer' }[k] || 'NBD') + '"'; },
    thursday: function (k) { return 'Thursday took a call from this number and typed it'; },
    calltype: function (k) { return 'its last two calls were both noted this way'; },
    lead: function (k, extra) { return extra && extra.leadName ? 'this number is on customer ' + extra.leadName : 'this number is on a customer'; },
    pattern: function (k, extra) { return (extra && extra.count ? extra.count : PATTERN_CALLS) + ' calls in ' + PATTERN_DAYS + ' days, none noted'; },
  };

  var d10 = function (v) { return LG.digits10(v); };
  function toMs(t) {
    if (t == null) return 0;
    if (typeof t === 'number') return t;
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    var v = Date.parse(t); return isFinite(v) ? v : 0;
  }
  function dismissedKinds(dismissals, digits) {
    var rec = dismissals && (typeof dismissals.get === 'function' ? dismissals.get(digits) : dismissals[digits]);
    var list = rec && Array.isArray(rec.dismissed) ? rec.dismissed : [];
    return list.map(function (x) { return x && x.kind; }).filter(Boolean);
  }

  /**
   * Candidate suggestions for ONE number.
   * @param o.digits      10-digit number
   * @param o.calls       this number's call / text-day rows (newest first not required)
   * @param o.thursday    thursday_calls rows [{ from, callerType }]
   * @param o.leadName    name of the customer this number is on ('' / undefined = none)
   * @param o.onLead      true when a lead carries the number
   * @param o.now         ms
   */
  function candidatesFor(o) {
    var out = [];
    var calls = (o.calls || []).filter(function (c) { return c && d10(c.phoneDigits) === o.digits; });
    // tag
    var tagged = {};
    calls.forEach(function (c) { var k = LG.seedKindFromTags(c.tags); if (k) tagged[k] = true; });
    Object.keys(tagged).forEach(function (k) { out.push({ kind: k, evidence: 'tag' }); });
    // thursday
    (o.thursday || []).forEach(function (t) {
      if (!t || d10(t.from) !== o.digits) return;
      var k = THURSDAY_KIND[t.callerType];
      if (k && !out.some(function (x) { return x.kind === k && x.evidence === 'thursday'; })) out.push({ kind: k, evidence: 'thursday' });
    });
    // two most recent NOTED calls agree
    var noted = calls.filter(function (c) { return c.channel !== 'text' && c.status === 'noted' && CALLTYPE_KIND[c.callType]; })
      .sort(function (a, b) { return toMs(b.startedAtMs) - toMs(a.startedAtMs); }).slice(0, 2);
    if (noted.length === 2 && noted[0].callType === noted[1].callType) out.push({ kind: CALLTYPE_KIND[noted[0].callType], evidence: 'calltype' });
    // lead
    // (only while some call from it is not filed on the customer yet — a
    // number the CRM already matched needs no hint)
    if (o.onLead && calls.some(function (c) { return !c.leadId; })) out.push({ kind: 'customer', evidence: 'lead', extra: { leadName: o.leadName || '' } });
    // pattern: unlabeled unknown number, 3+ calls in 14 days, none noted
    var recent = calls.filter(function (c) { return c.channel !== 'text' && toMs(c.startedAtMs) >= (o.now || Date.now()) - PATTERN_DAYS * DAY; });
    if (!o.onLead && recent.length >= PATTERN_CALLS && !recent.some(function (c) { return c.status === 'noted' && c.summary; })) {
      out.push({ kind: '', evidence: 'pattern', extra: { count: recent.length } });
    }
    return out;
  }

  /**
   * The ONE suggestion for a number, or null.
   * o.labels / o.dismissals: { digits10: ... }; see candidatesFor for the rest.
   */
  function suggestFor(o) {
    o = o || {};
    o.digits = d10(o.digits);
    if (!o.digits) return null;
    if (LG.lookup(o.labels, o.digits)) return null;                 // already labeled
    var dismissed = dismissedKinds(o.dismissals, o.digits);
    var cands = candidatesFor(o).filter(function (c) {
      // a dismissed kind stays dismissed; the kind-less pattern is dismissed as '*'
      return dismissed.indexOf(c.kind || '*') === -1;
    });
    if (!cands.length) return null;
    cands.sort(function (a, b) { return RANK[a.evidence] - RANK[b.evidence]; });
    var c = cands[0];
    // A kind that is already what every unlabeled number gets adds nothing for
    // evidence as weak as "on a customer": keep it, but it ranks last (above).
    var hides = !!c.kind && LG.defaultPolicy(c.kind) === 'hide';
    return {
      digits: o.digits,
      kind: c.kind,                                   // '' = no kind guessed (pattern)
      evidence: c.evidence,
      source: SOURCE_OF[c.evidence],
      why: WHY[c.evidence](c.kind, c.extra),
      title: c.kind ? 'Looks like ' + (LG.KIND_LABEL[c.kind] || c.kind) : 'Unknown number calling a lot',
      needsSheet: !c.kind || hides,                   // Accept opens the sheet instead of applying
      rank: RANK[c.evidence],
      latestMs: Math.max.apply(null, [0].concat((o.calls || []).map(function (x) { return toMs(x && x.startedAtMs); }))),
    };
  }

  /**
   * Suggestions for a list of numbers, ranked, capped. rows = every call /
   * text-day row the caller holds; the engine groups them by number.
   * ctx: { labels, dismissals, thursday, leadFor(digits) -> {leadName}|null, now, max }
   */
  function buildSuggestions(rows, ctx) {
    ctx = ctx || {};
    var by = {};
    (rows || []).forEach(function (c) { var d = c && d10(c.phoneDigits); if (d) (by[d] = by[d] || []).push(c); });
    var out = [];
    Object.keys(by).forEach(function (d) {
      var lead = typeof ctx.leadFor === 'function' ? ctx.leadFor(d) : null;
      var s = suggestFor({ digits: d, calls: by[d], thursday: ctx.thursday, labels: ctx.labels, dismissals: ctx.dismissals, onLead: !!lead, leadName: lead && lead.leadName, now: ctx.now });
      if (s) out.push(s);
    });
    out.sort(function (a, b) { return a.rank - b.rank || b.latestMs - a.latestMs; });
    return out.slice(0, ctx.max == null ? MAX_VISIBLE : ctx.max);
  }

  /** The dismissal doc after "Not this" (kept small: newest 12). */
  function withDismissal(existing, kind, nowMs) {
    var list = (existing && Array.isArray(existing.dismissed) ? existing.dismissed : []).filter(function (x) { return x && x.kind !== (kind || '*'); });
    list.push({ kind: kind || '*', atMs: nowMs });
    return list.slice(-12);
  }

  var API = {
    MAX_VISIBLE: MAX_VISIBLE, PATTERN_CALLS: PATTERN_CALLS, PATTERN_DAYS: PATTERN_DAYS, SOURCE_OF: SOURCE_OF,
    candidatesFor: candidatesFor, suggestFor: suggestFor, buildSuggestions: buildSuggestions, withDismissal: withDismissal,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root && root.document) root.NBDContactSuggestLogic = API;
})(typeof window !== 'undefined' ? window : null);
