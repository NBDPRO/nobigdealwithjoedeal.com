/* storm-check.js — "Is It Worth a Claim?" storm/hail lead qualifier (v1).
 * Marketing-surface only. Captures leads via the hardened submitPublicLead
 * pipeline (kind 'inspect', source '/storm-check'). Storm data is a
 * best-effort enhancement from IEM (public, no key); every external call
 * degrades gracefully so the funnel always works.
 *
 * Compliance: this tool NEVER guarantees a claim is approved or will pay
 * out — it only tells the homeowner it's worth a free inspection and that
 * Joe documents + files the claim. No dollar figures are promised.
 */
(function () {
  'use strict';

  var PROXY = 'https://us-central1-nobigdeal-pro.cloudfunctions.net/publicFunnelAI';
  var S = {
    step: 1, address: '', addressFull: null, lat: null, lon: null,
    stormWhen: '', stormType: '', roofAge: '', roofType: 'asphalt',
    signs: [], firstName: '', phone: '', email: '', submitted: false
  };
  var $ = function (id) { return document.getElementById(id); };

  /* ── step navigation ── */
  function goToStep(n) {
    if (n > S.step && !validate(S.step)) return;
    document.querySelectorAll('.sc-step').forEach(function (s) { s.classList.remove('active'); });
    var t = $('sc-step' + n);
    if (!t) return;
    t.classList.add('active'); S.step = n;
    var pct = ((n - 1) / 4) * 100;
    var fill = $('sc-progress-fill'); if (fill) fill.style.width = pct + '%';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (n === 5) {} // contact step
  }
  function validate(step) {
    if (step === 1) {
      if (!S.addressFull) {
        // Typed but never picked (mouse or keyboard) — resolve the top match
        // instead of dead-ending; pickAddr fills S.addressFull so the next
        // Continue press advances.
        var typedInp = $('sc-address');
        var typed = typedInp ? typedInp.value.trim() : '';
        if (typed.length >= 5) { resolveTyped(typed); }
        else { hint('Type your address and pick it from the dropdown.'); }
        return false;
      }
      return true;
    }
    if (step === 2) return !!(S.stormWhen && S.stormType);
    if (step === 3) return !!(S.roofAge);
    return true;
  }
  function hint(msg) {
    var el = $('sc-addr-hint'); if (!el) return;
    el.textContent = msg || ''; el.style.display = msg ? 'block' : 'none';
  }

  /* ── address autocomplete (Nominatim, Cincinnati-biased) ── */
  var debTimer = null, seq = 0;
  function wireAddress() {
    var inp = $('sc-address'), drop = $('sc-acdrop');
    if (!inp) return;
    inp.setAttribute('role', 'combobox');
    inp.setAttribute('aria-autocomplete', 'list');
    inp.setAttribute('aria-expanded', 'false');
    inp.setAttribute('aria-controls', 'sc-acdrop');
    if (drop) drop.setAttribute('role', 'listbox');
    inp.addEventListener('input', function () {
      S.addressFull = null;
      clearTimeout(debTimer);
      var q = this.value.trim();
      if (q.length < 4) { closeDrop(); return; }
      debTimer = setTimeout(function () { searchAddr(q); }, 350);
    });
    // Keyboard path: the dropdown items are divs, so without this a
    // keyboard/screen-reader user could type but never select — and step 1
    // hard-gates on S.addressFull, leaving them stuck on the first screen.
    inp.addEventListener('keydown', function (e) {
      var open = drop && drop.style.display === 'block';
      var items = open ? drop.querySelectorAll('.sc-ac-item') : [];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!open || !items.length) return;
        e.preventDefault();
        kbIdx = e.key === 'ArrowDown'
          ? (kbIdx + 1) % items.length
          : (kbIdx <= 0 ? items.length - 1 : kbIdx - 1);
        markActive(items);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (open && items.length) { pickAddr(kbIdx >= 0 ? kbIdx : 0); }
        else if (!S.addressFull) { resolveTyped(inp.value.trim()); }
      } else if (e.key === 'Escape') {
        closeDrop();
      }
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.sc-input-wrap')) closeDrop();
    });
  }
  var kbIdx = -1;
  function markActive(items) {
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('kb-active', i === kbIdx);
      items[i].setAttribute('aria-selected', i === kbIdx ? 'true' : 'false');
    }
    var inp = $('sc-address');
    if (inp) inp.setAttribute('aria-activedescendant', kbIdx >= 0 ? 'sc-ac-opt-' + kbIdx : '');
  }
  function closeDrop() {
    var drop = $('sc-acdrop'), inp = $('sc-address');
    if (drop) drop.style.display = 'none';
    if (inp) { inp.setAttribute('aria-expanded', 'false'); inp.setAttribute('aria-activedescendant', ''); }
    kbIdx = -1;
  }
  // Typed-without-picking fallback (same pattern as the estimate funnel's
  // _resolveAddressInline): resolve the top geocoder match so typing alone
  // is enough to proceed.
  function resolveTyped(q) {
    if (!q || q.length < 5) { hint('Type your address and pick it from the dropdown.'); return; }
    hint('Looking up that address…');
    var url = 'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(q) +
      '&format=json&addressdetails=1&countrycodes=us&limit=1' +
      '&viewbox=' + encodeURIComponent('-85.2,39.5,-83.6,38.6') + '&bounded=0';
    fetch(url).then(function (r) { return r.json(); }).then(function (data) {
      if (!data || !data.length) { hint("Couldn't find that address. Please type more of it."); return; }
      window._scAc = data;
      pickAddr(0);
    }).catch(function () { hint('Address lookup failed. Check your connection and try again.'); });
  }
  function searchAddr(q) {
    var drop = $('sc-acdrop'), my = ++seq;
    var url = 'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(q) +
      '&format=json&addressdetails=1&countrycodes=us&limit=5' +
      '&viewbox=' + encodeURIComponent('-85.2,39.5,-83.6,38.6') + '&bounded=0';
    fetch(url).then(function (r) { return r.json(); }).then(function (data) {
      if (my !== seq) return;
      if (!data.length) { drop.style.display = 'none'; return; }
      window._scAc = data;
      drop.innerHTML = data.map(function (d, i) {
        return '<div class="sc-ac-item" role="option" id="sc-ac-opt-' + i + '" aria-selected="false" data-idx="' + i + '">' + String(d.display_name).replace(/[<>]/g, '') + '</div>';
      }).join('');
      drop.style.display = 'block';
      kbIdx = -1;
      var kin = $('sc-address');
      if (kin) kin.setAttribute('aria-expanded', 'true');
    }).catch(function () { if (my === seq) drop.style.display = 'none'; });
  }
  function pickAddr(i) {
    var d = (window._scAc || [])[i]; if (!d) return;
    S.addressFull = d; S.address = d.display_name;
    S.lat = parseFloat(d.lat); S.lon = parseFloat(d.lon);
    $('sc-address').value = d.display_name;
    closeDrop();
    hint('');
  }

  /* ── tile select (single + multi) ── */
  function selectTile(tile, group) {
    if (group === 'signs') {
      var v = tile.getAttribute('data-value');
      tile.classList.toggle('selected');
      if (v === 'none') { // "none/not sure" clears the rest
        S.signs = tile.classList.contains('selected') ? ['none'] : [];
        document.querySelectorAll('[data-group="signs"] .sc-tile').forEach(function (t) {
          if (t !== tile) t.classList.remove('selected');
        });
      } else {
        var noneT = document.querySelector('[data-group="signs"][data-value="none"]');
        if (noneT) noneT.classList.remove('selected');
        S.signs = [].slice.call(document.querySelectorAll('[data-group="signs"] .sc-tile.selected'))
          .map(function (t) { return t.getAttribute('data-value'); });
      }
      return;
    }
    var parent = tile.closest('.sc-tiles');
    if (parent) parent.querySelectorAll('.sc-tile').forEach(function (t) { t.classList.remove('selected'); });
    tile.classList.add('selected');
    S[group] = tile.getAttribute('data-value');
  }

  /* ── IEM storm data (best-effort) ── */
  function iso(d) { return d.toISOString().slice(0, 16) + 'Z'; }
  function haversineMi(la1, lo1, la2, lo2) {
    var R = 3958.8, dLa = (la2 - la1) * Math.PI / 180, dLo = (lo2 - lo1) * Math.PI / 180;
    var a = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
      Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  function stormReports() {
    if (S.lat == null || S.lon == null) return Promise.resolve(null);
    var days = S.stormWhen === 'recent' ? 60 : 365;
    var ets = new Date(), sts = new Date(Date.now() - days * 864e5);
    var url = 'https://mesonet.agron.iastate.edu/geojson/lsr.geojson?sts=' + iso(sts) +
      '&ets=' + iso(ets) + '&states=OH,KY,IN';
    return fetch(url).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (!j || !j.features) return null;
      return j.features.map(function (f) {
        var c = f.geometry && f.geometry.coordinates; var p = f.properties || {};
        var t = String(p.typetext || '').toUpperCase();
        if (!c || !/HAIL|WND DMG|WND GST|TORNADO/.test(t)) return null;
        return { mi: haversineMi(S.lat, S.lon, c[1], c[0]), type: t, mag: p.magf, when: p.valid || p.utc_valid || '' };
      }).filter(function (x) { return x && x.mi <= 30; }).sort(function (a, b) { return a.mi - b.mi; });
    }).catch(function () { return null; });
  }

  /* ── verdict ── */
  function fmtDate(s) { try { var d = new Date(s); return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); } catch (e) { return ''; } }
  function buildVerdict(reports) {
    var age = S.roofAge, oldRoof = (age === '15-20' || age === '20+');
    var hasSigns = S.signs.length && S.signs.indexOf('none') === -1;
    var dataLine = '';
    var hail = (reports || []).filter(function (r) { return /HAIL/.test(r.type); });
    var wind = (reports || []).filter(function (r) { return /WND|TORNADO/.test(r.type); });
    if (hail.length) {
      var h = hail[0];
      dataLine = 'Official records show ' + hail.length + ' hail report' + (hail.length > 1 ? 's' : '') +
        ' within 30 miles of you' + (h.mag ? ' (up to ' + h.mag + '″)' : '') +
        (h.when ? ', the nearest on ' + fmtDate(h.when) : '') + '.';
    } else if (wind.length) {
      dataLine = 'Official records show ' + wind.length + ' wind/storm-damage report' + (wind.length > 1 ? 's' : '') +
        ' within 30 miles of you' + (wind[0].when ? ', the nearest on ' + fmtDate(wind[0].when) : '') + '.';
    }
    var strong = (hail.length || wind.length) && (oldRoof || hasSigns);
    var headline, detail;
    if (strong) {
      headline = 'Storm activity near you is worth a free inspection.';
      detail = 'A documented storm in your area plus ' + (hasSigns ? 'the signs you described' : 'your roof’s age') +
        ' is a good reason to get a trained eye on the roof — only an inspection can show whether there’s real damage. Joe documents anything he finds and writes the estimate; if you file, he meets your adjuster on the roof — the claim stays yours.';
    } else if (hail.length || wind.length || hasSigns) {
      headline = 'It’s worth a free inspection.';
      detail = 'There’s enough here to get a trained eye on it. Joe will get on the roof, document anything claimable, and tell you straight whether it’s worth filing — no pressure.';
    } else {
      headline = 'A quick free inspection will tell you for sure.';
      detail = 'Hard to call from the street. Joe will check it in person, document any damage, and walk you through your options — free, no obligation.';
    }
    return { headline: headline, detail: detail, dataLine: dataLine };
  }

  /* ── Joe's take (best-effort AI) ── */
  function joesTake() {
    var fb = S.firstName + ', I’ll get on your roof, document anything the storm did, and meet your adjuster on the roof if you file. No pressure either way.';
    try {
      var prompt = 'You are Joe Deal, owner of No Big Deal Home Solutions, a Cincinnati roofer who documents storm damage, writes the estimate, and meets the adjuster on the roof — the homeowner owns and decides their own claim. Write a 2-sentence, warm, no-BS note to ' +
        (S.firstName || 'a homeowner') + ' who just used your storm-damage self-check. Roof age: ' + S.roofAge +
        '. Signs reported: ' + (S.signs.join(', ') || 'none') + '. Do NOT promise the claim will be approved or pay out; say you’ll inspect free, document the damage, and meet the adjuster on the roof — the claim stays theirs. No dollar amounts.';
      return fetch(PROXY, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt, maxTokens: 180 })
      }).then(function (r) { return r.json(); }).then(function (d) {
        var txt = d && d.text;
        return (txt && txt.trim()) ? txt.trim() : fb;
      }).catch(function () { return fb; });
    } catch (e) { return Promise.resolve(fb); }
  }

  /* ── shared intake block (2026-09-30, Jo: every service form asks the same):
     REQUIRED scheduling choice, best time, insurance, how-heard, photos —
     intake-extras.js. If the block never loaded, the lead is never blocked. ── */
  var IP = 'scI';
  function mountIntake() {
    var box = $('sc-intake');
    if (!box || box.childElementCount) return true;
    if (!window.NBDIntake) return false;
    box.innerHTML = window.NBDIntake.html(IP);
    return true;
  }
  function readIntake() {
    var box = $('sc-intake');
    if (!window.NBDIntake || !box || !box.childElementCount) return { fields: {}, files: [] };
    return window.NBDIntake.read(box, IP);
  }
  function afterIntake(res, boxId) {
    if (!window.NBDIntake || !S.intake || !(res && res.ok)) return;
    window.NBDIntake.afterSubmit($(boxId), { prefix: IP, fields: S.intake.fields, files: S.intake.files, photoToken: res.photoToken || null,
      firstName: S.firstName || '', phone: S.phone || '', email: S.email || '', address: S.address || '', service: 'Roof inspection' });
  }

  /* ── submit + result ── */
  function submitLead() {
    var fn = $('sc-firstName').value.trim(), ph = $('sc-phone').value.trim(),
        em = $('sc-email').value.trim(), consent = $('sc-consent').checked;
    if (!fn || ph.replace(/\D/g, '').replace(/^1/, '').length !== 10) { $('sc-contact-err').textContent = 'Please add your name and a 10-digit phone.'; return; }
    if (!consent) { $('sc-contact-err').textContent = 'Please check the consent box so Joe can reach you.'; return; }
    var intake = readIntake();
    if (intake.error) { $('sc-contact-err').textContent = intake.error; if (intake.el && intake.el.classList) intake.el.classList.add('nbd-intake-invalid'); return; }
    S.intake = intake;
    $('sc-contact-err').textContent = '';
    S.firstName = fn; S.phone = ph; S.email = em;
    var btn = $('sc-submit'); btn.disabled = true; btn.textContent = 'Checking…';

    // capture the lead FIRST (so it saves even if the result errors out)
    var story = 'STORM CHECK | storm: ' + S.stormWhen + '/' + S.stormType +
      ' | roof age: ' + S.roofAge + ' (' + S.roofType + ') | signs: ' + (S.signs.join(', ') || 'none');
    // tcpaConsent is the checkbox's real value (always true past the gate above);
    // submitPublicLead persists it so lead-alert's SMS ack can gate on a stored
    // record instead of inferring consent (TCPA fix, 2026-09-04; see #1377).
    var payload = { name: fn, phone: ph, address: S.address || $('sc-address').value.trim(), source: '/storm-check', story: story, tcpaConsent: consent === true };
    if (em) payload.email = em;
    Object.assign(payload, S.intake.fields);
    var capture = (typeof window.submitPublicLead === 'function')
      ? window.submitPublicLead('inspect', payload)
      : Promise.resolve({ ok: false });

    // show loading, run storm lookup + AI in parallel
    goToStep(6);
    Promise.all([capture, stormReports()]).then(function (res) {
      var lead = res[0], reports = res[1];
      S.submitted = !!(lead && lead.ok);
      var verdict = buildVerdict(reports);
      joesTake().then(function (take) { renderResult(verdict, take, lead); afterIntake(lead, 'sc-intake-after'); });
    });
  }
  function renderResult(v, take, lead) {
    $('sc-result-headline').textContent = v.headline;
    $('sc-result-detail').textContent = v.detail;
    var dl = $('sc-result-data');
    if (v.dataLine) { dl.textContent = v.dataLine; dl.style.display = 'block'; } else { dl.style.display = 'none'; }
    $('sc-result-take').textContent = take;
    if (!(lead && lead.ok)) {
      var w = $('sc-result-warn');
      if (w) { w.style.display = 'block'; w.textContent = 'Heads up: we couldn’t auto-save your info — please call or text Joe at (859) 420-7382 so it isn’t lost.'; }
    }
    document.querySelectorAll('.sc-step').forEach(function (s) { s.classList.remove('active'); });
    $('sc-result').classList.add('active');
    var fill = $('sc-progress-fill'); if (fill) fill.style.width = '100%';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (window.gtag) window.gtag('event', 'storm_check_complete', { has_storm_data: !!v.dataLine });
  }

  /* ── phone formatting ── */
  function wirePhone() {
    var el = $('sc-phone'); if (!el) return;
    el.addEventListener('input', function () {
      var v = this.value.replace(/\D/g, '').slice(0, 10);
      if (v.length >= 7) this.value = '(' + v.slice(0, 3) + ') ' + v.slice(3, 6) + '-' + v.slice(6);
      else if (v.length >= 4) this.value = '(' + v.slice(0, 3) + ') ' + v.slice(3);
      else this.value = v;
    });
  }

  /* ── delegated clicks (CSP-safe, no inline handlers) ── */
  function wire() {
    wireAddress(); wirePhone();
    if (!mountIntake()) { var _it = 0, _iv = setInterval(function () { if (mountIntake() || ++_it > 40) clearInterval(_iv); }, 250); }
    document.addEventListener('click', function (e) {
      var ac = e.target.closest('.sc-ac-item[data-idx]'); if (ac) { pickAddr(+ac.dataset.idx); return; }
      var tile = e.target.closest('.sc-tile[data-value]');
      if (tile) { var g = tile.closest('[data-group]'); if (g) { selectTile(tile, g.dataset.group); } return; }
      var step = e.target.closest('[data-step]'); if (step) { goToStep(+step.dataset.step); return; }
      var act = e.target.closest('[data-action]'); if (act && act.dataset.action === 'submit') { submitLead(); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
