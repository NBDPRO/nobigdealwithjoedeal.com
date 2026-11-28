/* repair-or-replace.js — the "Should I repair or replace my roof?" quick check
 * on /repair-or-replace (2026-11-28).
 *
 * Five questions (roof age, what you're seeing, how widespread, past repairs,
 * how long you plan to stay) give an honest LEAN, never a verdict:
 *   'repair'     → "Likely a repair"
 *   'inspect'    → "Worth an inspection to decide"
 *   'replace'    → "Likely nearing replacement"
 * Every result ends with "an inspection confirms it" and a link to /inspect.
 * No prices, no insurance outcomes. Nothing leaves the page: no lead is
 * created and the answers are never sent anywhere. GA4 gets the lean and the
 * age band only (no PII).
 *
 * The scoring is a pure function (score) exported for
 * tests/repair-or-replace-2026-11-28.test.js; the page wiring only runs when
 * a document with the form exists. With JavaScript off the form stays hidden
 * (noscript CSS) and the page's "read your own answers" guide carries the
 * same rules in words.
 */
(function (root) {
  'use strict';

  // Points toward replacement. Each table lists every allowed answer.
  var AGE = { 'under-10': 0, '10-15': 1, '15-20': 2, '20-plus': 3, unsure: 1 };
  var SIGNS = { leak: 1, missing: 0, worn: 2, granules: 2, soft: 3, storm: 0, none: 0 };
  var SPREAD = { one: 0, side: 1, wide: 3, unsure: 1 };
  var REPAIRS = { none: 0, one: 1, several: 2, unsure: 0 };
  var STAY = { short: -1, medium: 0, long: 1, unsure: 0 };
  var SIGNS_CAP = 3; // several signs on one roof are one problem, not five

  var REPAIR_MAX = 2;  // total <= 2 → likely a repair
  var REPLACE_MIN = 6; // total >= 6 → likely nearing replacement

  var LEANS = {
    repair: 'Likely a repair',
    inspect: 'Worth an inspection to decide',
    replace: 'Likely nearing replacement'
  };
  var CONFIRM = 'An inspection confirms it.';

  function has(table, key) { return Object.prototype.hasOwnProperty.call(table, key); }

  /** Which required answers are missing or not allowed. */
  function missing(a) {
    a = a || {};
    var out = [];
    if (!has(AGE, a.age)) out.push('age');
    var signs = Array.isArray(a.signs) ? a.signs : [];
    if (!signs.length || signs.some(function (s) { return !has(SIGNS, s); })) out.push('signs');
    if (!has(SPREAD, a.spread)) out.push('spread');
    if (!has(REPAIRS, a.repairs)) out.push('repairs');
    if (!has(STAY, a.stay)) out.push('stay');
    return out;
  }

  /**
   * score({ age, signs: [...], spread, repairs, stay })
   *   → { lean, label, points, reasons: [...], notes: [...], confirm }
   * Throws on a missing or unknown answer so a caller can't score half a form.
   */
  function score(a) {
    var gaps = missing(a);
    if (gaps.length) throw new Error('repair-or-replace: missing answers: ' + gaps.join(', '));
    var signs = a.signs.indexOf('none') >= 0 && a.signs.length > 1
      ? a.signs.filter(function (s) { return s !== 'none'; })
      : a.signs.slice();
    var signPts = 0;
    signs.forEach(function (s) { signPts += SIGNS[s]; });
    signPts = Math.min(signPts, SIGNS_CAP);
    var points = AGE[a.age] + signPts + SPREAD[a.spread] + REPAIRS[a.repairs] + STAY[a.stay];

    var lean = points <= REPAIR_MAX ? 'repair' : points >= REPLACE_MIN ? 'replace' : 'inspect';

    // Overrides, each one a rule a roofer would state out loud.
    var soft = signs.indexOf('soft') >= 0;
    // Soft or sagging spots are the decking under the shingles: never "just a repair" from a quiz.
    if (soft && lean === 'repair') lean = 'inspect';
    // An old roof worn across several slopes is nearing the end whatever else is true.
    if (a.age === '20-plus' && a.spread === 'wide' && (signs.indexOf('worn') >= 0 || signs.indexOf('granules') >= 0)) lean = 'replace';
    // A young roof with one problem spot and no soft decking is a repair.
    if (a.age === 'under-10' && a.spread === 'one' && !soft) lean = 'repair';

    var reasons = [];
    if (a.age === '20-plus') reasons.push('At 20+ years, most asphalt shingle roofs are near the end of their life.');
    else if (a.age === '15-20') reasons.push('At 15 to 20 years, a roof can go either way. Condition matters more than age.');
    else if (a.age === '10-15') reasons.push('At 10 to 15 years, a well-installed roof usually has life left to protect.');
    else if (a.age === 'under-10') reasons.push('Under 10 years, the roof should have plenty of life left, so fixing the problem spot is usually the right call.');
    else reasons.push('You weren’t sure of the age. The shingles themselves tell me a lot on a visit.');

    if (soft) reasons.push('Soft or sagging spots point at the decking under the shingles. That needs eyes on it, and soon.');
    if (signs.indexOf('worn') >= 0 || signs.indexOf('granules') >= 0) reasons.push('Curling, cracking or granule loss is wear across the shingles, not a single broken spot.');
    if (signs.indexOf('missing') >= 0 && !soft) reasons.push('Missing or blown-off shingles in one area are often a straight repair.');
    if (signs.indexOf('leak') >= 0) reasons.push('A leak can be one failed pipe boot or flashing, or a sign the system is going. Finding the real source decides it.');

    if (a.spread === 'one') reasons.push('One spot is the classic repair situation.');
    else if (a.spread === 'side') reasons.push('Problems on one side or slope can sometimes be fixed on their own.');
    else if (a.spread === 'wide') reasons.push('Problems across several slopes usually mean the roof as a whole is wearing out.');

    if (a.repairs === 'several') reasons.push('Two or more repairs already means you may be chasing problems.');
    else if (a.repairs === 'one') reasons.push('One past repair is normal. Another one soon would be worth a closer look.');

    if (a.stay === 'short') reasons.push('If you’re selling soon, a sound repair is often enough, as long as it holds up to a buyer’s inspection.');
    else if (a.stay === 'long') reasons.push('Staying 10+ years makes a roof that’s near the end worth replacing once instead of repairing again and again.');

    var notes = [];
    if (signs.indexOf('leak') >= 0) notes.push('leak');
    if (signs.indexOf('storm') >= 0) notes.push('storm');

    return { lean: lean, label: LEANS[lean], points: points, reasons: reasons, notes: notes, confirm: CONFIRM };
  }

  var API = {
    score: score, missing: missing, LEANS: LEANS, CONFIRM: CONFIRM,
    TABLES: { AGE: AGE, SIGNS: SIGNS, SPREAD: SPREAD, REPAIRS: REPAIRS, STAY: STAY },
    REPAIR_MAX: REPAIR_MAX, REPLACE_MIN: REPLACE_MIN, SIGNS_CAP: SIGNS_CAP
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.NBDRepairOrReplace = API;

  // ── Page wiring ───────────────────────────────────────────────────────────
  var doc = root.document;
  if (!doc || typeof doc.getElementById !== 'function') return;

  function gtagEvent(name, params) { try { if (typeof root.gtag === 'function') root.gtag('event', name, params || {}); } catch (e) { /* never break the tool */ } }

  function init() {
    var form = doc.getElementById('rr-form');
    var out = doc.getElementById('rr-result');
    if (!form || !out) return;
    var err = doc.getElementById('rr-error');
    var started = false;
    var lastLean = '';

    form.addEventListener('change', function (e) {
      if (!started) { started = true; gtagEvent('repair_replace_start'); }
      if (err) err.textContent = '';
      // "Nothing specific" and the real signs exclude each other.
      var none = form.querySelector('input[name="signs"][value="none"]');
      var t = e && e.target;
      if (none && t && t.name === 'signs') {
        if (t.value === 'none' && t.checked) {
          form.querySelectorAll('input[name="signs"]').forEach(function (b) { if (b !== none) b.checked = false; });
        } else if (t.value !== 'none' && t.checked) none.checked = false;
      }
    });

    function read() {
      var pick = function (n) { var el = form.querySelector('input[name="' + n + '"]:checked'); return el ? el.value : ''; };
      var signs = [];
      form.querySelectorAll('input[name="signs"]:checked').forEach(function (b) { signs.push(b.value); });
      return { age: pick('age'), signs: signs, spread: pick('spread'), repairs: pick('repairs'), stay: pick('stay') };
    }

    function el(tag, cls, text) {
      var n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (text) n.textContent = text;
      return n;
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var a = read();
      var gaps = missing(a);
      if (gaps.length) {
        var labels = { age: 'roof age', signs: 'what you’re seeing', spread: 'how widespread', repairs: 'past repairs', stay: 'how long you’ll stay' };
        if (err) err.textContent = 'Pick an answer for: ' + gaps.map(function (g) { return labels[g]; }).join(', ') + '. "Not sure" and "Nothing specific" count.';
        var first = form.querySelector('fieldset[data-q="' + gaps[0] + '"] input');
        if (first) first.focus();
        gtagEvent('repair_replace_incomplete', { missing: gaps.join(',') });
        return;
      }
      var r = score(a);
      lastLean = r.lean;

      while (out.firstChild) out.removeChild(out.firstChild);
      out.className = 'rr-result rr-lean-' + r.lean;
      var h = el('h2', 'rr-result-head', r.label);
      h.id = 'rr-result-head';
      out.appendChild(el('p', 'rr-result-kicker', 'My honest lean from your answers'));
      out.appendChild(h);
      var ul = el('ul', 'rr-reasons');
      r.reasons.forEach(function (t) { ul.appendChild(el('li', '', t)); });
      out.appendChild(ul);
      if (r.notes.indexOf('leak') >= 0) {
        var lk = el('p', 'rr-note');
        lk.appendChild(doc.createTextNode('Water coming in right now? Call or text me at '));
        var tel = el('a', '', '(859) 420-7382'); tel.href = 'tel:+18594207382';
        lk.appendChild(tel);
        lk.appendChild(doc.createTextNode(' and I’ll get it covered. '));
        var tarp = el('a', '', 'Emergency tarping'); tarp.href = '/services/emergency-roof-tarping';
        lk.appendChild(tarp);
        out.appendChild(lk);
      }
      if (r.notes.indexOf('storm') >= 0) {
        var st = el('p', 'rr-note');
        st.appendChild(doc.createTextNode('If a storm caused this, get it documented before you pay for a repair yourself. I document the damage with photos so you can decide whether to file a claim. '));
        var rc = el('a', '', 'Check your address’s storm history'); rc.href = '/roof-check';
        st.appendChild(rc);
        out.appendChild(st);
      }
      out.appendChild(el('p', 'rr-confirm', r.confirm + ' A quiz can’t see your roof. I get on it, take photos and tell you straight whether it’s a repair or a replacement.'));
      var cta = el('a', 'rr-cta', 'Book a free inspection →');
      cta.href = '/inspect';
      cta.setAttribute('data-rr-cta', 'inspect');
      out.appendChild(cta);
      var again = el('button', 'rr-again', 'Start over');
      again.type = 'button';
      again.addEventListener('click', function () {
        form.reset();
        while (out.firstChild) out.removeChild(out.firstChild);
        out.className = 'rr-result';
        var q1 = form.querySelector('input');
        if (q1) q1.focus();
      });
      out.appendChild(again);
      // The result region is aria-live (polite), so screen readers hear it
      // without a focus jump; it sits right after the button in tab order.
      try { out.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (x) { /* old browsers */ }
      gtagEvent('repair_replace_result', { lean: r.lean, roof_age: a.age });
    });

    out.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[data-rr-cta]') : null;
      if (a) gtagEvent('repair_replace_cta', { lean: lastLean, cta: a.getAttribute('data-rr-cta') });
    });
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : globalThis);
