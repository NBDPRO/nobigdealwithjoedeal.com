/* roof-check.js — /roof-check "Free Roof Check" (2026-11-25).
 *
 * One tool where there were three: the Storm Damage Check (/storm-check), the
 * Roof Health Score (/roof-score) and the 5-Year Storm Report (/storm-report)
 * now 301 here (documentation/projects/ROOF-CHECK-MERGE-2026-11-25.md).
 *
 *   1  address            (Nominatim lookup on blur / Check, never per keystroke)
 *   2  FREE storm history (GET /api/storm-report: NWS/IEM 5-yr data, no contact
 *                          asked; a failed lookup says so, never "no storms")
 *   3  roof questions     (age required; material; signs, incl. water stains inside)
 *   4  contact            (name + phone; email + texting consent optional)
 *                          -> submitPublicLead('inspect', source '/roof-check')
 *                          BEFORE any result, so the lead is saved first
 *   5  result             (plain verdict from storm data + answers, Joe's take
 *                          via publicFunnelAI ONLY after contact, the full storm
 *                          table / map / gusts, optional details + photos)
 *
 * Compliance: storm DATA, not an insurance determination. The verdict is at
 * most "worth a free inspection"; never a claim outcome or a dollar figure.
 * Joe documents damage and meets the adjuster; the homeowner owns the claim.
 */
(function () {
  'use strict';

  var API = window.__NBD_STORM_API || '/api/storm-report';
  var PROXY = 'https://us-central1-nobigdeal-pro.cloudfunctions.net/publicFunnelAI';
  // A cold lookup is five IEM calls; an IEM outage fails fast server-side in
  // about 40 s. After 60 s the page lands in "couldn't check" with Retry.
  var LOOKUP_TIMEOUT_MS = 60000;
  var AI_TIMEOUT_MS = 30000;
  // Progress per screen (the result is 100).
  var PROGRESS = { 1: 0, 2: 25, 3: 50, 4: 75, 5: 90 };

  var $ = function (id) { return document.getElementById(id); };
  var S = {
    step: 1, address: '', addressFull: null, addressTyped: '', lat: null, lon: null,
    data: null, roofAge: '', roofType: 'asphalt', signs: [],
    firstName: '', phone: '', email: '', intake: null, submitted: false
  };
  function gtagEvent(name, params) { try { if (typeof window.gtag === 'function') window.gtag('event', name, params || {}); } catch (e) { /* never break the funnel */ } }

  // Tap-to-call in error and save messages: the text is set with textContent,
  // so the number is swapped for a tel: link here, built with DOM calls.
  function telify(el) {
    if (!el || typeof el.appendChild !== 'function' || typeof document.createElement !== 'function') return;
    var t = el.textContent || '', n = '(859) 420-7382', i = t.indexOf(n);
    if (i < 0) return;
    el.textContent = t.slice(0, i);
    var a = document.createElement('a');
    a.href = 'tel:+18594207382';
    a.textContent = n;
    el.appendChild(a);
    var rest = t.slice(i + n.length);
    if (rest) { var s = document.createElement('span'); s.textContent = rest; el.appendChild(s); }
  }

  /* ── screens ── */
  var SCREENS = { 1: 'rc-step1', 2: 'rc-teaser', 3: 'rc-step3', 4: 'rc-step4', 5: 'rc-step5' };
  function show(id, pct) {
    document.querySelectorAll('.rc-step').forEach(function (s) { s.classList.remove('active'); });
    var t = $(id);
    if (t) t.classList.add('active');
    var fill = $('rc-progress-fill'); if (fill) fill.style.width = pct + '%';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (t && typeof t.querySelector === 'function') focusEl(t.querySelector('h2') || $('rc-result-headline'));
  }
  function goToStep(n) {
    if (n > S.step && !validate(S.step)) return;
    if (!SCREENS[n]) return;
    S.step = n;
    show(SCREENS[n], PROGRESS[n]);
    if (n === 3) gtagEvent('roof_check_questions');
    if (n === 4) gtagEvent('roof_check_contact');
  }
  /* The button just pressed sits on the screen being hidden, so focus moves to
     the new screen's heading (tabindex -1: reachable by script, never by Tab). */
  function focusEl(el) {
    if (!el || typeof el.setAttribute !== 'function') return;
    el.setAttribute('tabindex', '-1');
    el.style.outline = 'none';
    if (typeof el.focus === 'function') el.focus({ preventScroll: true });
  }

  /* ── required answers (screen 3) ──
     A role=alert line under the subtitle says what to pick; focus lands on the
     first unanswered group. Created empty at load so a screen reader already
     watches it, and it follows the answers as they land (afterPick). */
  var NEED = { 3: [['roofAge', 'how old the roof is']] };
  function missing(step) { return (NEED[step] || []).filter(function (q) { return !S[q[0]]; }); }
  function needText(step) {
    var m = missing(step);
    return m.length ? 'Pick ' + m.map(function (q) { return q[1]; }).join(' and ') + '.' : '';
  }
  function needNote(step) { return document.querySelector('#rc-step' + step + ' .rc-need'); }
  function mountNeedNotes() {
    Object.keys(NEED).forEach(function (n) {
      var st = $('rc-step' + n), first = st && st.querySelector('.rc-label');
      if (!first || needNote(n)) return;
      var note = document.createElement('div');
      note.className = 'rc-err rc-need';
      note.setAttribute('role', 'alert');
      note.style.minHeight = '0';
      st.insertBefore(note, first);
    });
  }
  function needAnswers(step) {
    var m = missing(step);
    if (!m.length) return true;
    var note = needNote(step);
    if (note) note.textContent = needText(step);
    var first = document.querySelector('#rc-step' + step + ' [data-group="' + m[0][0] + '"] .rc-tile');
    if (first) first.focus({ preventScroll: true });
    if (note) note.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return false;
  }
  function validate(step) {
    if (step === 3) return needAnswers(3);
    return true;
  }
  function hint(msg) {
    var el = $('rc-addr-hint'); if (!el) return;
    el.textContent = msg || ''; el.style.display = msg ? 'block' : 'none';
  }

  /* ── address (Nominatim, Cincinnati-biased) ──
     Lookup on blur or Check, never per keystroke (2026-10-15, review H4): the
     public Nominatim policy forbids autocomplete-as-you-type. One debounced
     lookup when the field loses focus, at least 5 characters, each distinct
     string looked up once per page (geocodeOnce). */
  var debTimer = null, seq = 0, kbIdx = -1;
  function wireAddress() {
    var inp = $('rc-address'), drop = $('rc-acdrop');
    if (!inp) return;
    inp.setAttribute('role', 'combobox');
    inp.setAttribute('aria-autocomplete', 'list');
    inp.setAttribute('aria-expanded', 'false');
    inp.setAttribute('aria-controls', 'rc-acdrop');
    if (drop) drop.setAttribute('role', 'listbox');
    inp.addEventListener('input', function () {
      S.addressFull = null; S.lat = null; S.lon = null;
      if (S.addressTyped && this.value.trim() !== S.addressTyped) S.addressTyped = '';
      clearTimeout(debTimer);
      closeDrop();
    });
    inp.addEventListener('blur', function () {
      clearTimeout(debTimer);
      var q = this.value.trim();
      if (q.length < 5 || S.addressFull || S.addressTyped) return;
      debTimer = setTimeout(function () { searchAddr(q); }, 400);
    });
    // Keyboard path: the dropdown items are divs, so arrows + Enter select.
    inp.addEventListener('keydown', function (e) {
      var open = drop && drop.style.display === 'block';
      var items = open ? drop.querySelectorAll('.rc-ac-item') : [];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!open || !items.length) return;
        e.preventDefault();
        kbIdx = e.key === 'ArrowDown' ? (kbIdx + 1) % items.length : (kbIdx <= 0 ? items.length - 1 : kbIdx - 1);
        markActive(items);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (open && items.length) { pickAddr(kbIdx >= 0 ? kbIdx : 0); }
        else { generate(); }
      } else if (e.key === 'Escape') {
        closeDrop();
      }
    });
    document.addEventListener('click', function (e) {
      if (!e.target || typeof e.target.closest !== 'function' || !e.target.closest('.rc-input-wrap')) closeDrop();
    });
  }
  function markActive(items) {
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('kb-active', i === kbIdx);
      items[i].setAttribute('aria-selected', i === kbIdx ? 'true' : 'false');
    }
    var inp = $('rc-address');
    if (inp) inp.setAttribute('aria-activedescendant', kbIdx >= 0 ? 'rc-ac-opt-' + kbIdx : '');
  }
  function closeDrop() {
    var drop = $('rc-acdrop'), inp = $('rc-address');
    if (drop) drop.style.display = 'none';
    if (inp) { inp.setAttribute('aria-expanded', 'false'); inp.setAttribute('aria-activedescendant', ''); }
    kbIdx = -1;
  }
  var geoCache = {};
  function geocodeOnce(q) {
    var key = String(q || '').trim().toLowerCase();
    if (!geoCache[key]) {
      var url = 'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(q) +
        '&format=json&addressdetails=1&countrycodes=us&limit=5' +
        '&viewbox=' + encodeURIComponent('-85.2,39.5,-83.6,38.6') + '&bounded=0';
      geoCache[key] = fetch(url).then(function (r) {
        if (!r.ok) throw new Error('geocode-failed');
        return r.json();
      }).catch(function (e) { delete geoCache[key]; throw e; });
    }
    return geoCache[key];
  }
  function searchAddr(q) {
    var drop = $('rc-acdrop'), my = ++seq;
    geocodeOnce(q).then(function (data) {
      if (my !== seq) return;
      if (!data.length) { drop.style.display = 'none'; return; }
      window._rcAc = data;
      drop.innerHTML = data.map(function (d, i) {
        return '<div class="rc-ac-item" role="option" id="rc-ac-opt-' + i + '" aria-selected="false" data-idx="' + i + '">' + String(d.display_name).replace(/[<>&"]/g, '') + '</div>';
      }).join('');
      drop.style.display = 'block';
      kbIdx = -1;
      var kin = $('rc-address'); if (kin) kin.setAttribute('aria-expanded', 'true');
    }).catch(function () { if (my === seq) drop.style.display = 'none'; });
  }
  function pickAddr(i) {
    var d = (window._rcAc || [])[i]; if (!d) return;
    S.addressFull = d; S.addressTyped = ''; S.address = d.display_name;
    S.lat = parseFloat(d.lat); S.lon = parseFloat(d.lon);
    $('rc-address').value = d.display_name;
    closeDrop();
    hint('');
  }
  // The map lookup is a convenience, never a gate (2026-10-15, review H3):
  // when it finds nothing or fails, offer "Use my address as typed". Storm
  // records need a map point, so that path shows the honest "couldn't check"
  // history and still lets the homeowner ask Joe.
  function offerTyped(msg) {
    hint(msg);
    var el = $('rc-addr-hint'); if (!el || typeof el.appendChild !== 'function') return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'rc-back';
    b.style.cssText = 'display:block;margin-top:10px;padding:10px 16px;';
    b.setAttribute('data-action', 'useTypedAddress');
    b.textContent = 'Use my address as typed →';
    el.appendChild(b);
  }
  function useTypedAddress() {
    var inp = $('rc-address'); var addr = inp ? inp.value.trim() : '';
    if (addr.length < 5) { hint('Type your address and pick it from the dropdown.'); return; }
    S.addressFull = null; S.addressTyped = addr; S.address = addr;
    S.lat = null; S.lon = null;
    closeDrop(); hint('');
    lookupStorms();
  }

  /* ── step 1 -> 2: the free storm history ── */
  function generate() {
    if (S.lat == null && !S.addressTyped) {
      var typed = ($('rc-address').value || '').trim();
      if (typed.length < 5) { hint('Type your address and pick it from the dropdown.'); return; }
      hint('Looking up that address…');
      geocodeOnce(typed).then(function (data) {
        if (!data || !data.length) { offerTyped('We couldn’t find that address on the map. Check it, or continue with it as typed.'); return; }
        window._rcAc = data; pickAddr(0); lookupStorms();
      }).catch(function () { offerTyped('The map lookup isn’t responding. You can continue with your address as typed.'); });
      return;
    }
    lookupStorms();
  }
  function lookupStorms() {
    S.step = 2;
    show('rc-loading', PROGRESS[2]);
    gtagEvent('roof_check_generate');
    if (S.lat == null || S.lon == null) { failedLookup(); return; }
    var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, LOOKUP_TIMEOUT_MS) : 0;
    fetch(API + '?lat=' + S.lat + '&lon=' + S.lon, ctl ? { signal: ctl.signal } : undefined)
      .then(function (r) { if (!r.ok) throw new Error('storm-lookup-' + r.status); return r.json(); })
      .then(function (j) {
        clearTimeout(timer);
        // The server's own empty:true fallback, a body with no counts and a partial
        // lookup that found nothing are all "we could not check", not "no storms".
        if (!j || !j.counts || j.empty || (j.partial && !j.counts.total)) throw new Error('storm-lookup-unavailable');
        S.data = j; renderTeaser();
      })
      .catch(function () { clearTimeout(timer); failedLookup(); });
  }
  function failedLookup() {
    S.data = { counts: { total: 0, hail: 0, wind: 0, tornado: 0, stormDays: 0 }, events: [], _err: true };
    renderTeaser();
  }
  function nearWithin(mi) { return ((S.data && S.data.events) || []).filter(function (e) { return e.distanceMi <= mi; }); }
  function renderTeaser() {
    var c = S.data.counts || {};
    if (S.data._err) {
      // A failed lookup is not "no storms": no zero counts, no all-clear line.
      $('rc-teaser-headline').textContent = 'We couldn’t check storm records right now';
      $('rc-teaser-sub').textContent = 'The lookup didn’t finish, so this is not a “no storms” result. Try again in a moment, or have Joe check your roof for free: an inspection is the only way to be sure.';
      $('rc-teaser-chips').innerHTML = '';
      $('rc-retry').hidden = !(S.lat != null && S.lon != null);
    } else {
      $('rc-retry').hidden = !S.data.partial;
      var h10 = nearWithin(10).filter(function (e) { return e.type === 'hail'; }).length;
      $('rc-teaser-headline').textContent = (c.total > 0)
        ? 'We found ' + c.total + ' storm events near this address'
        : 'No major storm reports logged near this address';
      $('rc-teaser-sub').textContent = (c.total > 0)
        ? 'Over the last ' + (S.data.years || 5) + ' years within ' + (S.data.radiusMi || 30) + ' miles: ' +
          (c.hail || 0) + ' hail, ' + (c.wind || 0) + ' wind, ' + (c.tornado || 0) + ' tornado' +
          (S.data.maxHail ? ' · hail up to ' + S.data.maxHail + '″' : '') + '.' +
          (S.data.partial ? ' Some of the records couldn’t be checked just now, so there may be more.' : '')
        : 'That doesn’t rule out damage. A free inspection is the only way to be sure.';
      $('rc-teaser-chips').innerHTML =
        chip((c.hail || 0) + ' hail') + chip((c.wind || 0) + ' wind') +
        chip((c.tornado || 0) + ' tornado') + chip((c.stormDays || 0) + ' storm days') +
        (h10 ? chip(h10 + ' hail within 10 mi') : '');
    }
    S.step = 2;
    show('rc-teaser', PROGRESS[2]);
    gtagEvent('roof_check_history', { events: S.data._err ? -1 : (c.total || 0), lookup_failed: !!S.data._err });
  }
  function chip(t) { return '<span class="rc-chip">' + t + '</span>'; }

  /* ── tiles (single + multi) ── */
  function selectTile(tile, group) {
    if (group === 'signs') {
      var v = tile.getAttribute('data-value');
      tile.classList.toggle('selected');
      if (v === 'none') { // "none / not sure" clears the rest
        S.signs = tile.classList.contains('selected') ? ['none'] : [];
        document.querySelectorAll('[data-group="signs"] .rc-tile').forEach(function (t) { if (t !== tile) t.classList.remove('selected'); });
      } else {
        var noneT = document.querySelector('[data-group="signs"] .rc-tile[data-value="none"]');
        if (noneT) noneT.classList.remove('selected');
        S.signs = [].slice.call(document.querySelectorAll('[data-group="signs"] .rc-tile.selected'))
          .map(function (t) { return t.getAttribute('data-value'); });
      }
      afterPick(tile);
      return;
    }
    var parent = tile.closest('.rc-tiles');
    if (parent) parent.querySelectorAll('.rc-tile').forEach(function (t) { t.classList.remove('selected'); });
    tile.classList.add('selected');
    S[group] = tile.getAttribute('data-value');
    afterPick(tile);
  }
  // Tile state was only a CSS class: expose it (aria-pressed), and shrink the
  // "Pick ..." line to what is still missing.
  function afterPick(tile) {
    var box = tile.closest('.rc-tiles');
    if (box) box.querySelectorAll('.rc-tile').forEach(function (t) {
      t.setAttribute('aria-pressed', t.classList.contains('selected') ? 'true' : 'false');
    });
    var note = needNote(S.step);
    if (note && note.textContent) note.textContent = needText(S.step);
  }

  /* ── verdict: storm records + the roof answers ── */
  function buildVerdict() {
    var d = S.data || { counts: {}, events: [], _err: true };
    var c = d.counts || {};
    var oldRoof = (S.roofAge === '15-20' || S.roofAge === '20+');
    var signs = S.signs.filter(function (s) { return s !== 'none'; });
    var hasSigns = signs.length > 0;
    var stain = signs.indexOf('leak') !== -1;
    var near = nearWithin(10);
    var hailNear = near.filter(function (e) { return e.type === 'hail'; }).length;
    var severe = (d.events || []).some(function (e) { return e.severity === 'severe'; });
    var stormy = !d._err && !!(c.hail || c.tornado || c.wind > 3);
    var dataLine = '';
    if (!d._err && c.total > 0) {
      dataLine = 'Official records show ' + c.total + ' storm event' + (c.total > 1 ? 's' : '') + ' within ' + (d.radiusMi || 30) +
        ' miles of you in the last ' + (d.years || 5) + ' years (' + (c.hail || 0) + ' hail' + (d.maxHail ? ', up to ' + d.maxHail + '″' : '') +
        ')' + (hailNear ? ', ' + hailNear + ' hail report' + (hailNear > 1 ? 's' : '') + ' within 10 miles' : '') + '.';
    }
    var headline, detail;
    if (d._err) {
      headline = 'We couldn’t check storm records right now';
      detail = 'The storm-records lookup didn’t finish, so this result has no storm data in it. That is not a “no storms” result. ' +
        (hasSigns ? 'The signs you described are reason enough to get a trained eye on the roof. ' : (oldRoof ? 'At your roof’s age it’s worth a trained eye anyway. ' : '')) +
        'A free inspection is the only way to be sure: Joe checks it free, documents anything he finds and tells you straight what he saw.';
    } else if (stormy && (oldRoof || hasSigns || ((hailNear || c.tornado) && severe))) {
      headline = 'Storm activity near you is worth a free inspection.';
      detail = 'Documented storms near your home plus ' + (hasSigns ? 'the signs you described' : (oldRoof ? 'your roof’s age' : 'how severe they were')) +
        ' is a good reason to get a trained eye on the roof. Only an inspection can show whether there’s real damage. Joe documents anything he finds and writes the estimate; if you file, he meets your adjuster on the roof. The claim stays yours.';
    } else if (stormy || hasSigns) {
      headline = 'It’s worth a free inspection.';
      detail = 'There’s enough here to get a trained eye on it. Joe will get on the roof, document what he finds and tell you straight, so you can decide what to do next. No pressure.';
    } else if (d.partial) {
      headline = 'A free inspection is the only way to be sure.';
      detail = 'Part of the storm history couldn’t be checked just now, so we can’t call it light, and damage isn’t always obvious from the ground. Joe checks it free, no obligation.';
    } else {
      headline = 'A quick free inspection will tell you for sure.';
      detail = 'Light storm history on record near you, and nothing you’ve noticed yet. Damage isn’t always obvious from the ground, so Joe checks it free if you want to be sure. No obligation.';
    }
    if (stain) detail += ' Water stains inside mean water is getting in somewhere, so it’s worth a look soon, storm or not.';
    return { headline: headline, detail: detail, dataLine: dataLine };
  }

  /* ── Joe's take (best-effort AI, only after the lead is in) ──
     Structured answers only (2026-11-14, AI audit F5): the server builds the
     prompt (functions/public-funnel-ai-logic.js) and refuses free text. */
  function joesTake() {
    var fb = (S.firstName ? S.firstName + ', ' : '') + 'I’ll get on your roof, document anything I find, and meet your adjuster on the roof if you file. No pressure either way.';
    try {
      var aiRequest = { kind: 'stormCheck', firstName: S.firstName || '', roofAge: S.roofAge, signs: S.signs };
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, AI_TIMEOUT_MS) : null;
      return fetch(PROXY, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(aiRequest),
        signal: ctrl ? ctrl.signal : undefined
      }).then(function (r) { return r.json(); }).then(function (d) {
        var txt = d && d.text;
        return (txt && String(txt).trim()) ? String(txt).trim() : fb;
      }).catch(function () { return fb; }).then(function (t) { clearTimeout(timer); return t; });
    } catch (e) { return Promise.resolve(fb); }
  }

  /* ── shared intake block (intake-extras.js): REQUIRED scheduling choice on
     the contact step; best time, insurance, how-heard and photos on the result
     screen. If the block never loaded, the lead is never blocked. ── */
  var IP = 'rcI';
  var XP = 'rcX';
  var _grant = null;
  var _busy = false;
  function mountIntake() {
    var box = $('rc-intake');
    if (!box || box.childElementCount) return true;
    if (!window.NBDIntake) return false;
    box.innerHTML = window.NBDIntake.html(IP, { extras: false });
    return true;
  }
  function readIntake() {
    var box = $('rc-intake');
    if (!window.NBDIntake || !box || !box.childElementCount) return { fields: {}, files: [] };
    return window.NBDIntake.read(box, IP);
  }
  function calInfo() {
    return { firstName: S.firstName || '', phone: S.phone || '', email: S.email || '', address: S.address || '', service: 'Roof inspection' };
  }
  function wireBookLink() {
    var a = $('rc-book');
    if (a && window.NBDIntake && typeof window.NBDIntake.calendarUrl === 'function') a.setAttribute('href', window.NBDIntake.calendarUrl(calInfo()));
  }
  function afterIntake(res, boxId) {
    if (!window.NBDIntake || !S.intake || !(res && res.ok)) return;
    window.NBDIntake.afterSubmit($(boxId), { prefix: IP, ownCalendar: true, fields: S.intake.fields, files: [], photoToken: null, firstName: S.firstName || '' });
  }
  function mountDetails(res) {
    var wrap = $('rc-details'), box = $('rc-x-intake');
    // No grant = nothing to save against, so the block stays hidden.
    if (!wrap || !box || !window.NBDIntake || !(res && res.ok && res.photoToken)) return;
    _grant = res.photoToken;
    if (!box.childElementCount) box.innerHTML = window.NBDIntake.html(XP, { sched: false });
    wrap.hidden = false;
  }
  function detailsStatus(msg, isError) {
    var st = $('rc-details-status');
    if (!st) return;
    st.className = 'rc-details-status' + (isError ? ' error' : '');
    st.textContent = msg;
    telify(st);
  }
  function saveDetails() {
    var btn = $('rc-details-save');
    if (_busy || !_grant || !btn) return;
    var box = $('rc-x-intake');
    var intake = (window.NBDIntake && box && box.childElementCount) ? window.NBDIntake.read(box, XP, { optional: true }) : { fields: {}, files: [] };
    if (intake.error) { detailsStatus(intake.error, true); return; }
    var answers = {};
    ['bestTime', 'insuranceClaim', 'howHeard'].forEach(function (k) { if (intake.fields[k]) answers[k] = intake.fields[k]; });
    var hasAnswers = Object.keys(answers).length > 0;
    var files = intake.files || [];
    if (!hasAnswers && !files.length) { detailsStatus('Add something first, or skip this. Joe already has your request.', true); return; }
    _busy = true; btn.disabled = true; btn.textContent = 'Saving...';
    var base = typeof window.nbdPublicFunctionsBase === 'function' ? window.nbdPublicFunctionsBase() : '';
    var post = !hasAnswers ? Promise.resolve(true) : fetch(base + '/updatePublicLeadIntake', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit', mode: 'cors',
      body: JSON.stringify(Object.assign({ token: _grant }, answers))
    }).then(function (r) { return r.ok; }, function () { return false; });
    return post.then(function (saved) {
      _busy = false;
      if (!saved) { btn.disabled = false; btn.textContent = 'Send to Joe'; detailsStatus('Couldn’t save that. Call or text Joe at (859) 420-7382.', true); return; }
      btn.textContent = 'Sent';
      detailsStatus(hasAnswers ? 'Thanks, that’s on your request now.' : '', false);
      // Photos: the same grant, uploaded and reported by intake-extras.js.
      if (files.length && window.NBDIntake) {
        window.NBDIntake.afterSubmit($('rc-intake-after'), { prefix: XP, ownCalendar: true, quietContact: true, fields: intake.fields, files: files, photoToken: _grant,
          firstName: S.firstName || '', phone: S.phone || '', address: S.address || '' });
      }
    });
  }

  /* ── step 4: save the lead FIRST, then the result ── */
  // The internal story line. Its storm part keeps the exact shape the storm-
  // report email rebuilds its summary from (functions/storm-report-email.js);
  // a failed lookup says so, never "0 events/5yr".
  function storyLine() {
    var d = S.data || { _err: true }, c = d.counts || {};
    var storms = d._err ? 'storm records unavailable' :
      (c.total || 0) + ' events/' + ((d.years || 5) - (d.failedYears || 0)) + 'yr (' +
      (c.hail || 0) + ' hail, ' + (c.wind || 0) + ' wind, ' + (c.tornado || 0) + ' tornado, max ' + (d.maxHail || 0) + '″)';
    return 'ROOF CHECK | ' + storms + ' | roof age: ' + (S.roofAge || 'unknown') + ' (' + (S.roofType || 'unknown') +
      ') | signs: ' + (S.signs.join(', ') || 'none');
  }
  function submitLead() {
    var fn = $('rc-firstName').value.trim(), ph = $('rc-phone').value.trim(),
        em = ($('rc-email') ? $('rc-email').value : '').trim(), consent = $('rc-consent').checked;
    var err = $('rc-contact-err');
    if (!fn || ph.replace(/\D/g, '').replace(/^1/, '').length !== 10) { err.textContent = 'Please add your name and a 10-digit phone.'; return; }
    if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { err.textContent = 'That email doesn’t look right. Fix it, or leave it blank.'; return; }
    // Texting consent is optional (2026-10-15): the lead is saved either way; no automatic text without it.
    var intake = readIntake();
    if (intake.error) { $('rc-contact-err').textContent = intake.error; if (intake.el && intake.el.classList) intake.el.classList.add('nbd-intake-invalid'); return; }
    S.intake = intake;
    err.textContent = '';
    S.firstName = fn; S.phone = ph; S.email = em;
    var btn = $('rc-submit'); btn.disabled = true; btn.textContent = 'Saving…';

    // tcpaConsent: the checkbox's real value (true or false), persisted so the
    // SMS ack gates on a stored record (TCPA fix, 2026-09-04; see #1377).
    var payload = { name: fn, phone: ph, address: S.address || $('rc-address').value.trim(), source: '/roof-check', story: storyLine(), tcpaConsent: consent === true };
    if (em) payload.email = em;
    // The point the storm history was built for: the follow-up email finds the
    // same server-built report for its measured-gust line; the CRM lead gets lat/lng.
    if (S.lat != null && isFinite(S.lat) && isFinite(S.lon)) { payload.lat = S.lat; payload.lon = S.lon; }
    Object.assign(payload, S.intake.fields);
    // The one-time grant the result screen's optional "add details" step saves against.
    payload.wantsFollowUp = true;
    var capture = (typeof window.submitPublicLead === 'function')
      ? window.submitPublicLead('inspect', payload)
      : Promise.resolve({ ok: false });
    gtagEvent('roof_check_submit');
    S.step = 5;
    show('rc-step5', PROGRESS[5]);
    // The AI note runs only now, after the visitor gave their contact details.
    capture.then(function (lead) { return lead; }, function () { return { ok: false }; }).then(function (lead) {
      S.submitted = !!(lead && lead.ok);
      var verdict = buildVerdict();
      joesTake().then(function (take) { renderResult(verdict, take, lead); afterIntake(lead, 'rc-intake-after'); mountDetails(lead); });
    });
  }

  /* ── result ── */
  function renderResult(v, take, lead) {
    $('rc-result-headline').textContent = v.headline;
    $('rc-result-detail').textContent = v.detail;
    var dl = $('rc-result-data');
    if (v.dataLine) { dl.textContent = v.dataLine; dl.style.display = 'block'; } else { dl.style.display = 'none'; }
    $('rc-result-take').textContent = take;
    if (!(lead && lead.ok)) {
      var w = $('rc-result-warn');
      if (w) { w.style.display = 'block'; w.textContent = 'Heads up: we couldn’t auto-save your info. Please call or text Joe at (859) 420-7382 so it isn’t lost.'; telify(w); }
    }
    renderReport();
    wireBookLink();
    S.step = 6;
    show('rc-result', 100);
    if (!(S.data && S.data._err)) initMap();
    var c = (S.data && S.data.counts) || {};
    gtagEvent('roof_check_complete', { has_storm_data: !!v.dataLine, events: (S.data && S.data._err) ? -1 : (c.total || 0) });
  }
  function renderReport() {
    var d = S.data || { counts: {}, events: [], _err: true };
    var c = d.counts || {}, failed = d._err === true;
    $('rc-rep-summary').innerHTML = failed ? '' :
      stat(c.total || 0, 'storm events') + stat(c.hail || 0, 'hail') + stat(c.wind || 0, 'wind') +
      stat(c.tornado || 0, 'tornado') + stat((Number(d.maxHail) || 0) + '″', 'max hail');
    // notable events: hail + tornado + severe/significant wind, newest first, cap 25
    var notable = (d.events || []).filter(function (e) { return e.type !== 'wind' || e.severity !== 'minor'; }).slice(0, 25);
    if (!notable.length) notable = (d.events || []).slice(0, 15);
    $('rc-rep-rows').innerHTML = notable.map(function (e) {
      var type = /^(hail|wind|tornado)$/.test(e.type) ? e.type : 'wind';
      return '<tr><td>' + esc(fmtDate(e.date)) + '</td><td><span class="rc-tag rc-' + type + '">' + type + '</span></td><td>' +
        (e.magnitude ? esc(String(e.magnitude) + (e.unit ? e.unit : '')) : '—') + '</td><td>' + esc(String(e.distanceMi)) + ' mi</td></tr>';
    }).join('') || '<tr><td colspan="4" style="text-align:center;color:#5d6673">' +
      (failed ? 'Storm records couldn’t be checked right now, so no events are listed.' : 'No individual reports on file near this address.') + '</td></tr>';
    renderGusts();
    $('rc-rep-source').textContent = failed ? 'Storm records for this address could not be checked just now.' :
      'Source: ' + (d.source || 'NWS Local Storm Reports (NOAA)') + '. Report range: ' + (d.years || 5) + ' years within ' + (d.radiusMi || 30) + ' miles.' +
      (d.partial ? ' Some years could not be checked just now, so this list may be incomplete.' : '');
    // No map of an address we could not look up: an empty one reads as "nothing nearby".
    ['rc-map', 'rc-map-legend'].forEach(function (id) { var m = $(id); if (m) m.style.display = failed ? 'none' : ''; });
  }
  /* "Wind measured nearby": the nearest station's strongest gust on the top
     storm days, built server-side (stormReport -> windGusts[].line). Text only;
     the block stays hidden when there are none or no context line came with them. */
  function renderGusts() {
    var box = $('rc-rep-gusts'), list = $('rc-rep-gust-list');
    if (!box || !list) return;
    list.textContent = '';
    var g = (S.data && Array.isArray(S.data.windGusts)) ? S.data.windGusts : [];
    if (!(S.data && S.data.windGustContext)) g = [];
    var n = 0;
    g.forEach(function (x) {
      if (!x || typeof x.line !== 'string' || !x.line || !(Number(x.gustMph) > 0)) return;
      var li = document.createElement('li'); li.textContent = x.line; list.appendChild(li); n++;
    });
    $('rc-rep-gust-note').textContent = n ? String(S.data.windGustContext || '') : '';
    $('rc-rep-gust-source').textContent = (n && S.data.windGustSource) ? 'Wind gusts: ' + S.data.windGustSource : '';
    box.hidden = !n;
  }
  function stat(v, l) { return '<div class="rc-stat"><b>' + esc(String(v)) + '</b><span>' + l + '</span></div>'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (ch) { return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&quot;'; }); }
  // IEM report times are UTC with no zone suffix: the Eastern date via the one
  // storm-time reader (/pro/js/storm-time.js), never the browser's parse.
  function fmtDate(s) { var ST = window.NBDStormTime; return (ST && ST.dateTextEt(s)) || '—'; }

  /* ── Leaflet map (self-hosted, OSM tiles) ── */
  function initMap() {
    if (S.lat == null) return;
    if (typeof L === 'undefined') { loadLeaflet(drawMap); } else { drawMap(); }
  }
  function loadLeaflet(cb) {
    if (!$('lf-css')) { var c = document.createElement('link'); c.id = 'lf-css'; c.rel = 'stylesheet'; c.href = '/assets/vendor/leaflet/leaflet.css'; document.head.appendChild(c); }
    if (!$('lf-js')) { var s = document.createElement('script'); s.id = 'lf-js'; s.src = '/assets/vendor/leaflet/leaflet.js'; s.onload = cb; s.onerror = function () { var m = $('rc-map'); if (m) m.style.display = 'none'; }; document.head.appendChild(s); }
    else cb();
  }
  function drawMap() {
    var el = $('rc-map'); if (!el || el._init) return; el._init = true;
    var map = L.map('rc-map', { scrollWheelZoom: false }).setView([S.lat, S.lon], 10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 18 }).addTo(map);
    L.circleMarker([S.lat, S.lon], { radius: 8, color: '#12223d', fillColor: '#bd5728', fillOpacity: 1, weight: 3 }).addTo(map).bindPopup('Your property');
    var col = { hail: '#2563eb', wind: '#16a34a', tornado: '#dc2626' };
    ((S.data && S.data.events) || []).forEach(function (e) {
      if (e.lat == null) return;
      L.circleMarker([e.lat, e.lon], { radius: 4, color: col[e.type] || '#888', fillColor: col[e.type] || '#888', fillOpacity: .6, weight: 1 })
        .addTo(map).bindPopup(esc(e.type + (e.magnitude ? ' ' + e.magnitude + (e.unit || '') : '') + ' · ' + fmtDate(e.date)));
    });
  }

  function restart() {
    S.data = null; S.step = 1;
    show('rc-step1', PROGRESS[1]);
  }

  /* ── phone formatting ── */
  function wirePhone() {
    var el = $('rc-phone'); if (!el) return;
    el.addEventListener('input', function () {
      var v = this.value.replace(/\D/g, '');
      if (v.length > 10 && v.charAt(0) === '1') v = v.slice(1); // drop an autofilled +1 country code
      v = v.slice(0, 10);
      if (v.length >= 7) this.value = '(' + v.slice(0, 3) + ') ' + v.slice(3, 6) + '-' + v.slice(6);
      else if (v.length >= 4) this.value = '(' + v.slice(0, 3) + ') ' + v.slice(3);
      else this.value = v;
    });
  }

  /* ── delegated clicks (CSP-safe, no inline handlers) ── */
  function wire() {
    wireAddress(); wirePhone(); mountNeedNotes();
    document.querySelectorAll('.rc-tile').forEach(function (t) { t.setAttribute('type', 'button'); t.setAttribute('aria-pressed', 'false'); });
    if (!mountIntake()) { var _it = 0, _iv = setInterval(function () { if (mountIntake() || ++_it > 40) clearInterval(_iv); }, 250); }
    document.addEventListener('click', function (e) {
      if (!e.target || typeof e.target.closest !== 'function') return;
      var ac = e.target.closest('.rc-ac-item[data-idx]'); if (ac) { pickAddr(+ac.dataset.idx); return; }
      var tile = e.target.closest('.rc-tile[data-value]');
      if (tile) { var g = tile.closest('[data-group]'); if (g) { selectTile(tile, g.dataset.group); } return; }
      var step = e.target.closest('[data-step]'); if (step) { goToStep(+step.dataset.step); return; }
      var act = e.target.closest('[data-action]'); if (!act) return;
      var a = act.dataset.action;
      if (a === 'generate') generate();
      else if (a === 'retry') lookupStorms();
      else if (a === 'submit') submitLead();
      else if (a === 'saveDetails') saveDetails();
      else if (a === 'useTypedAddress') useTypedAddress();
      else if (a === 'print') window.print();
      else if (a === 'restart') restart();
    });
  }
  // Test seam: pure helpers only (no DOM state), read by the node suites.
  window.__nbdRoofCheck = { buildVerdict: buildVerdict, storyLine: storyLine, state: S };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
