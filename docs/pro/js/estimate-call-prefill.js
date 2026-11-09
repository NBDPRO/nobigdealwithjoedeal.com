/**
 * estimate-call-prefill.js — Call to Close P1 (2026-11-09): which estimate
 * builder CHOICES a reviewed call brief may fill in.
 * Design: documentation/projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md §5.1, Q8.
 *
 * Pure: no DOM, no Firestore. estimate-v2-ui.js loads it through
 * ScriptLoader the first time a call prefill arrives (no <script> tag, not in
 * a bundle), and applies the plan through the builder's own setters.
 *
 * What a call may set (each shown with a "from call" chip the rep can clear):
 *   jobMode (insurance | cash), workKind (repair | replacement), tier (one the
 *   company offers), stories (1-3), tear-off layers (1-3), chimney / skylight
 *   flashing (the per-SQ add-on switches, only ever turned ON, and only with
 *   the words that mention it: P2 scope.mentionQuotes; without them, or when
 *   they were hard to hear (scope.mentionUnsure), it is a hint line, never
 *   switched on).
 * What it never sets: rawSqft or any measurement, a price, rate, total,
 * deductible, ACV, warranty years, a signed tier, the scope or the floor. A
 * spoken square count is returned as the WORDS that were said, for a hint
 * beside the area input; it is never parsed into a number.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NBDEstimateCallPrefill = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // The only builder fields a call may touch. Order = chip order.
  var KEYS = ['jobMode', 'workKind', 'tier', 'stories', 'tearOffLayers', 'hasChimneyFlash', 'hasSkylightFlash'];
  var TIERS = ['economy', 'good', 'better', 'best', 'beyond'];
  var JOB_MODES = ['insurance', 'cash'];
  var WORK_KIND = { repair: 'repair', replace: 'replacement', replacement: 'replacement' };
  var SMALL = [1, 2, 3];
  var NAME = { jobMode: 'Job', workKind: 'Work', tier: 'Tier', stories: 'Stories', tearOffLayers: 'Layers', hasChimneyFlash: 'Chimney flashing', hasSkylightFlash: 'Skylight flashing' };
  // Template search: the job type each work kind looks in.
  var TEMPLATE_JOB_TYPE = { repair: 'repair', replacement: 'replacement' };
  // Words worth matching a template on (from the said service / damage).
  var STOP = { the: 1, and: 1, for: 1, with: 1, roof: 1, roofing: 1, repair: 1, repairs: 1, replace: 1, replacement: 1, full: 1, new: 1, just: 1, some: 1, want: 1, wants: 1, need: 1, needs: 1, around: 1, from: 1, that: 1, this: 1 };

  function str(v, n) { return typeof v === 'string' ? v.trim().slice(0, n || 300) : ''; }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function factValue(f) { return f && typeof f === 'object' ? f.value : undefined; }
  function factQuote(f) { return f && typeof f === 'object' ? str(f.quote, 300) : ''; }
  function smallInt(v) {
    if (typeof v === 'number') return SMALL.indexOf(v) !== -1 ? v : null;
    if (typeof v === 'string' && /^[123]$/.test(v.trim())) return Number(v.trim());
    return null;
  }
  function label(key, value) {
    if (key === 'jobMode') return value === 'cash' ? 'Cash' : 'Insurance';
    if (key === 'workKind') return value === 'repair' ? 'Repair' : 'Full roof';
    if (key === 'tier') return cap(value);
    if (key === 'stories') return value === 3 ? '3+ stories' : value + (value === 1 ? ' story' : ' stories');
    if (key === 'tearOffLayers') return value + (value === 1 ? ' layer' : ' layers');
    return 'Yes';
  }
  function item(key, value, quote) {
    return { key: key, value: value, quote: quote, name: NAME[key], label: label(key, value) };
  }
  function isSqft(q) {
    var t = String((q && (q.text + ' ' + q.quote)) || '').toLowerCase();
    return /\bsquares?\b|\bsq\b|\bsq\.|square f(ee|oo)t|\bsf\b/.test(t);
  }

  /**
   * The call's choices, from a sanitized brief (functions/call-brief-logic.js
   * sanitizeBrief). Reads named paths only; anything else on the object is
   * ignored. → { items:[{key,value,quote,name,label}], hints:{sqft[],said[],
   * mentions[]}, workKind, words }
   */
  function fromBrief(brief) {
    var out = { items: [], hints: { sqft: [], said: [], mentions: [], unsure: [] }, workKind: null, words: '' };
    var b = brief && typeof brief === 'object' ? brief : null;
    if (!b) return out;
    // Unreliable text grounds garbage: nothing from it (the server blanks it too).
    if (b.transcriptOk && b.transcriptOk.reliable === false) return out;
    var f = b.fields && typeof b.fields === 'object' ? b.fields : {};
    var sc = b.scope && typeof b.scope === 'object' ? b.scope : {};

    var jm = factValue(f.jobType);
    if (JOB_MODES.indexOf(jm) !== -1) out.items.push(item('jobMode', jm, factQuote(f.jobType)));
    var wk = WORK_KIND[factValue(f.workKind)];
    if (wk && typeof factValue(f.workKind) === 'string') {
      out.items.push(item('workKind', wk, factQuote(f.workKind)));
      out.workKind = wk;
    }
    var tv = factValue(sc.tierInterest);
    if (TIERS.indexOf(tv) !== -1) out.items.push(item('tier', tv, factQuote(sc.tierInterest)));
    // A count heard in a hard-to-hear stretch (retype) is never filled in:
    // it shows as the words said, for the rep to check (P1 integration).
    [['stories', sc.stories, 'Stories'], ['tearOffLayers', sc.layers, 'Layers']].forEach(function (x) {
      var n = smallInt(factValue(x[1]));
      if (!n) return;
      if (x[1].retype === true) out.hints.unsure.push(x[2] + ' was hard to hear on the recording (\u201c' + (factQuote(x[1]) || label(x[0], n)) + '\u201d), so it is not filled in. Check it and set it yourself.');
      else out.items.push(item(x[0], n, factQuote(x[1])));
    });
    var men = sc.mentions && typeof sc.mentions === 'object' ? sc.mentions : {};
    // A flashing switch adds a price line, so the chip needs the words said (P2).
    var mq = sc.mentionQuotes && typeof sc.mentionQuotes === 'object' ? sc.mentionQuotes : {};
    var mu = sc.mentionUnsure && typeof sc.mentionUnsure === 'object' ? sc.mentionUnsure : {};
    [['chimney', 'hasChimneyFlash', 'Chimney'], ['skylight', 'hasSkylightFlash', 'Skylight']].forEach(function (x) {
      if (men[x[0]] !== true) return;
      var q = str(mq[x[0]], 300);
      // Words from a hard-to-hear segment (scope.mentionUnsure): a line, never switched on.
      if (q && mu[x[0]] === true) out.hints.unsure.push(x[2] + ' was hard to hear on the recording (\u201c' + q + '\u201d), so its flashing is not switched on. Check it and set it yourself.');
      else if (q) out.items.push(item(x[1], true, q));
      // A full line beside the "not filled in" ones (the builder lists hints.unsure as written).
      else out.hints.unsure.push(x[2] + ' was mentioned on the call, but no exact words were kept, so its flashing is not switched on. Check it and set it yourself.');
    });
    if (men.gutters === true) out.hints.mentions.push('Gutters');
    if (men.decking === true) out.hints.mentions.push('Decking');

    (Array.isArray(sc.saidQuantities) ? sc.saidQuantities : []).slice(0, 6).forEach(function (q) {
      if (!q || typeof q !== 'object') return;
      var words = str(q.quote, 160) || str(q.text, 160);
      if (!words) return;
      (isSqft(q) ? out.hints.sqft : out.hints.said).push(words);
    });

    var said = [str(factValue(sc.service), 80), str(factValue(f.damageType), 60)];
    if (men.chimney === true) said.push('chimney');
    if (men.skylight === true) said.push('skylight');
    if (men.gutters === true) said.push('gutter');
    out.words = said.join(' ').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
    return out;
  }

  /**
   * What to change in the builder: [{ key, from, to, quote, name, label }].
   * ctx: { state (the builder's), leadJobType (the customer's own), tiers
   * (the tiers this company offers) }. Skips: a key not on KEYS, a value off
   * its list, no change, the customer's own job type (it wins), a work kind
   * the rep already set, a tier the company does not offer, and switching an
   * add-on OFF.
   */
  function plan(prefill, ctx) {
    var c = ctx || {};
    var s = c.state || {};
    var m = s.measurements || {};
    var tiers = Array.isArray(c.tiers) && c.tiers.length ? c.tiers : TIERS;
    var leadJt = String(c.leadJobType || '').trim().toLowerCase();
    var seen = {};
    var out = [];
    ((prefill && Array.isArray(prefill.items)) ? prefill.items : []).forEach(function (it) {
      if (!it || KEYS.indexOf(it.key) === -1 || seen[it.key]) return;
      var k = it.key, v = it.value, from;
      if (k === 'jobMode') {
        if (JOB_MODES.indexOf(v) === -1 || JOB_MODES.indexOf(leadJt) !== -1) return;
        from = s.jobMode;
      } else if (k === 'workKind') {
        if (v !== 'repair' && v !== 'replacement') return;
        if (s.workKind === 'repair' || s.workKind === 'replacement') return;
        from = s.workKind == null ? null : s.workKind;
      } else if (k === 'tier') {
        if (TIERS.indexOf(v) === -1 || tiers.indexOf(v) === -1) return;
        from = s.tier;
      } else if (k === 'stories' || k === 'tearOffLayers') {
        if (SMALL.indexOf(v) === -1) return;
        from = m[k];
      } else {
        if (v !== true) return;
        from = !!m[k];
      }
      if (from === v) return;
      seen[k] = true;
      out.push({ key: k, from: from, to: v, quote: str(it.quote, 300), name: NAME[k], label: label(k, v) });
    });
    return out;
  }

  /**
   * Job templates for the said work: JobTemplates.search filtered to the work
   * kind's job type (repair → repair templates: the quick quote), the ones
   * whose words match the call first. → [{ id, name }] (no price; the engine
   * prices whichever the rep taps).
   */
  function templateMatches(JT, prefill, limit) {
    var jt = prefill && TEMPLATE_JOB_TYPE[prefill.workKind];
    if (!jt || !JT || typeof JT.search !== 'function') return [];
    var list;
    try { list = JT.search('', { jobType: jt }) || []; } catch (_) { return []; }
    var words = String((prefill && prefill.words) || '').split(' ').filter(function (w) { return w.length >= 4 && !STOP[w]; });
    var scored = list.filter(function (t) { return t && t.id && t.jobType === jt; }).map(function (t, i) {
      var hay = [t.name, t.description, t.category].concat(Array.isArray(t.tags) ? t.tags : []).join(' ').toLowerCase();
      var score = words.reduce(function (n, w) { return n + (hay.indexOf(w.replace(/s$/, '')) !== -1 ? 1 : 0); }, 0);
      return { t: t, score: score, i: i };
    });
    scored.sort(function (a, b) { return (b.score - a.score) || (a.i - b.i); });
    // When the call's words match some templates, offer only those.
    if (scored.length && scored[0].score > 0) scored = scored.filter(function (x) { return x.score > 0; });
    return scored.slice(0, Math.max(0, Number(limit) || 5)).map(function (x) { return { id: String(x.t.id), name: String(x.t.name || x.t.id) }; });
  }

  return { KEYS: KEYS.slice(), TIERS: TIERS.slice(), fromBrief: fromBrief, plan: plan, templateMatches: templateMatches };
});
