/* roof-score.js — "Roof Health Score" self-assessment lead qualifier (v1).
 * Marketing-surface only. Captures leads via the hardened submitPublicLead
 * pipeline (kind 'inspect', source '/roof-score') — same shape as the live
 * /storm-check funnel, so no backend change is needed.
 *
 * Split-gate: the 0–100 score + band is shown FREE; the line-by-line
 * breakdown, recommendation and Joe's take are unlocked once the homeowner
 * leaves contact info.
 *
 * Compliance: the score is a self-assessment estimate, NOT a professional
 * inspection or a warranty of condition. No claim is guaranteed and no
 * dollar figures are promised anywhere.
 */
(function () {
  'use strict';

  var PROXY = 'https://us-central1-nobigdeal-pro.cloudfunctions.net/publicFunnelAI';
  var S = {
    step: 1, address: '', addressFull: null, lat: null, lon: null,
    roofAge: '', roofType: '', signs: [], moisture: '', lastInspect: '',
    firstName: '', phone: '', email: '', score: null, band: null, submitted: false
  };
  var $ = function (id) { return document.getElementById(id); };

  /* ── step navigation (quiz steps 1–4) ── */
  function goToStep(n) {
    if (n > S.step && !validate(S.step)) return;
    showOnly('rs-step' + n);
    S.step = n;
    setProgress(((n - 1) / 4) * 100);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function showOnly(id) {
    document.querySelectorAll('.sc-step').forEach(function (s) { s.classList.remove('active'); });
    var t = $(id); if (t) t.classList.add('active');
  }
  function setProgress(pct) { var f = $('rs-progress-fill'); if (f) f.style.width = pct + '%'; }
  function validate(step) {
    if (step === 1) {
      if (!S.addressFull) {
        var inp = $('rs-address'); var typed = inp ? inp.value.trim() : '';
        if (typed.length >= 5) { resolveTyped(typed); }
        else { hint('Type your address and pick it from the dropdown.'); }
        return false;
      }
      return true;
    }
    if (step === 2) {
      if (!S.roofAge) { flashLabel('roofAge'); return false; }
      return true;
    }
    if (step === 4) {
      if (!S.moisture || !S.lastInspect) {
        if (!S.moisture) flashLabel('moisture'); else flashLabel('lastInspect');
        return false;
      }
      return true;
    }
    return true; // step 3 (signs) is optional
  }
  function flashLabel(group) {
    var g = document.querySelector('[data-group="' + group + '"]');
    if (!g) return;
    g.scrollIntoView({ block: 'center', behavior: 'smooth' });
    g.querySelectorAll('.sc-tile').forEach(function (t) {
      t.style.borderColor = '#c23a2b';
      setTimeout(function () { t.style.borderColor = ''; }, 900);
    });
  }
  function hint(msg) {
    var el = $('rs-addr-hint'); if (!el) return;
    el.textContent = msg || ''; el.style.display = msg ? 'block' : 'none';
  }

  /* ── address autocomplete (Nominatim, Cincinnati-biased) — mirrors /storm-check ── */
  var debTimer = null, seq = 0, kbIdx = -1;
  function wireAddress() {
    var inp = $('rs-address'), drop = $('rs-acdrop');
    if (!inp) return;
    inp.setAttribute('role', 'combobox');
    inp.setAttribute('aria-autocomplete', 'list');
    inp.setAttribute('aria-expanded', 'false');
    inp.setAttribute('aria-controls', 'rs-acdrop');
    if (drop) drop.setAttribute('role', 'listbox');
    inp.addEventListener('input', function () {
      S.addressFull = null;
      clearTimeout(debTimer);
      var q = this.value.trim();
      if (q.length < 4) { closeDrop(); return; }
      debTimer = setTimeout(function () { searchAddr(q); }, 350);
    });
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
      } else if (e.key === 'Escape') { closeDrop(); }
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.sc-input-wrap')) closeDrop();
    });
  }
  function markActive(items) {
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('kb-active', i === kbIdx);
      items[i].setAttribute('aria-selected', i === kbIdx ? 'true' : 'false');
    }
    var inp = $('rs-address');
    if (inp) inp.setAttribute('aria-activedescendant', kbIdx >= 0 ? 'rs-ac-opt-' + kbIdx : '');
  }
  function closeDrop() {
    var drop = $('rs-acdrop'), inp = $('rs-address');
    if (drop) drop.style.display = 'none';
    if (inp) { inp.setAttribute('aria-expanded', 'false'); inp.setAttribute('aria-activedescendant', ''); }
    kbIdx = -1;
  }
  function resolveTyped(q) {
    if (!q || q.length < 5) { hint('Type your address and pick it from the dropdown.'); return; }
    hint('Looking up that address…');
    var url = 'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(q) +
      '&format=json&addressdetails=1&countrycodes=us&limit=1' +
      '&viewbox=' + encodeURIComponent('-85.2,39.5,-83.6,38.6') + '&bounded=0';
    fetch(url).then(function (r) { return r.json(); }).then(function (data) {
      if (!data || !data.length) { hint("Couldn't find that address. Please type more of it."); return; }
      window._rsAc = data; pickAddr(0);
    }).catch(function () { hint('Address lookup failed. Check your connection and try again.'); });
  }
  function searchAddr(q) {
    var drop = $('rs-acdrop'), my = ++seq;
    var url = 'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(q) +
      '&format=json&addressdetails=1&countrycodes=us&limit=5' +
      '&viewbox=' + encodeURIComponent('-85.2,39.5,-83.6,38.6') + '&bounded=0';
    fetch(url).then(function (r) { return r.json(); }).then(function (data) {
      if (my !== seq) return;
      if (!data.length) { drop.style.display = 'none'; return; }
      window._rsAc = data;
      drop.innerHTML = data.map(function (d, i) {
        return '<div class="sc-ac-item" role="option" id="rs-ac-opt-' + i + '" aria-selected="false" data-idx="' + i + '">' + String(d.display_name).replace(/[<>]/g, '') + '</div>';
      }).join('');
      drop.style.display = 'block';
      kbIdx = -1;
      var kin = $('rs-address'); if (kin) kin.setAttribute('aria-expanded', 'true');
    }).catch(function () { if (my === seq) drop.style.display = 'none'; });
  }
  function pickAddr(i) {
    var d = (window._rsAc || [])[i]; if (!d) return;
    S.addressFull = d; S.address = d.display_name;
    S.lat = parseFloat(d.lat); S.lon = parseFloat(d.lon);
    $('rs-address').value = d.display_name;
    closeDrop(); hint('');
  }

  /* ── tile select (single + multi) ── */
  function selectTile(tile, group) {
    if (group === 'signs') {
      var v = tile.getAttribute('data-value');
      tile.classList.toggle('selected');
      if (v === 'none') {
        S.signs = tile.classList.contains('selected') ? ['none'] : [];
        document.querySelectorAll('[data-group="signs"] .sc-tile').forEach(function (t) {
          if (t !== tile) t.classList.remove('selected');
        });
      } else {
        var noneT = document.querySelector('[data-group="signs"] .sc-tile[data-value="none"]');
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

  /* ── scoring model ──
   * Start at 100, subtract weighted deductions. Metal earns a small bonus.
   * Clamp to 3..99 (never a scary 0 or an over-promising 100). */
  var AGE_HIT = { '<5': 0, '5-10': 8, '10-15': 20, '15-20': 33, '20+': 48, 'unsure': 18 };
  var SIGN_HIT = { shingles: 13, granules: 10, dents: 8, sagging: 24, flashing: 9, moss: 7 };
  var MOIST_HIT = { none: 0, occasional: 12, active: 26, noaccess: 5 };
  var INSPECT_HIT = { recent: -4, mid: 0, never: 8, unsure: 4 };

  function computeScore() {
    var d = 0;
    d += (AGE_HIT[S.roofAge] != null ? AGE_HIT[S.roofAge] : 18);
    var signHit = 0;
    S.signs.forEach(function (s) { if (SIGN_HIT[s]) signHit += SIGN_HIT[s]; });
    d += Math.min(signHit, 50); // cap so a full board doesn't bottom out unfairly
    d += (MOIST_HIT[S.moisture] || 0);
    d += (INSPECT_HIT[S.lastInspect] || 0);
    if (S.roofType === 'metal') d -= 8; // longer service life
    var score = Math.max(3, Math.min(99, Math.round(100 - d)));
    return score;
  }
  function bandFor(score) {
    if (score >= 85) return { key: 'excellent', label: 'Excellent shape', color: '#22a06b',
      summary: 'Based on your answers, your roof looks to be in great condition.' };
    if (score >= 70) return { key: 'good', label: 'Good — minor watch items', color: '#3f9d4f',
      summary: 'Solid overall, with a few things worth keeping an eye on.' };
    if (score >= 50) return { key: 'fair', label: 'Fair — showing wear', color: '#d98a0b',
      summary: 'Your roof is showing real wear. A professional look is a smart move.' };
    if (score >= 30) return { key: 'poor', label: 'Poor — get it checked soon', color: '#bd5728',
      summary: 'Several warning signs are stacking up. Don’t wait too long on this one.' };
    return { key: 'critical', label: 'Critical — likely end of life', color: '#c23a2b',
      summary: 'Your answers point to a roof at or near the end of its service life.' };
  }

  /* ── factor breakdown (gated) ── */
  function buildFactors() {
    var f = [];
    // age
    var a = S.roofAge;
    if (a === '<5') f.push(['good', 'Roof age: under 5 years', 'Plenty of service life left.']);
    else if (a === '5-10') f.push(['good', 'Roof age: 5–10 years', 'Comfortably within its expected lifespan.']);
    else if (a === '10-15') f.push(['warn', 'Roof age: 10–15 years', 'Middle age — worth monitoring for wear.']);
    else if (a === '15-20') f.push(['bad', 'Roof age: 15–20 years', 'Approaching the end of a typical asphalt lifespan.']);
    else if (a === '20+') f.push(['bad', 'Roof age: 20+ years', 'Past the typical lifespan of an asphalt roof.']);
    else f.push(['warn', 'Roof age: unknown', 'Not knowing the age is itself a reason to get it checked.']);
    // material
    if (S.roofType === 'metal') f.push(['good', 'Metal roof', 'Metal typically outlasts asphalt — a plus for longevity.']);
    // signs
    var SIGN_TXT = {
      shingles: ['bad', 'Missing / cracked / curling shingles', 'Damaged shingles let water reach the deck.'],
      granules: ['warn', 'Granules in the gutters', 'A sign the shingles are wearing out.'],
      dents: ['warn', 'Impact dents (hail)', 'Often claimable — worth documenting before it ages out.'],
      sagging: ['bad', 'Sagging / soft spots', 'Can indicate deck or structural moisture damage.'],
      flashing: ['warn', 'Flashing rust or gaps', 'A common, fixable leak source around chimneys and valleys.'],
      moss: ['warn', 'Moss / algae / dark streaks', 'Traps moisture and can shorten shingle life.']
    };
    if (S.signs.indexOf('none') !== -1 || !S.signs.length) {
      f.push(['good', 'No visible damage reported', 'Nothing jumped out from the curb — a good sign.']);
    } else {
      S.signs.forEach(function (s) { if (SIGN_TXT[s]) f.push(SIGN_TXT[s]); });
    }
    // moisture
    var m = S.moisture;
    if (m === 'none') f.push(['good', 'No interior moisture', 'No stains or drips reported inside.']);
    else if (m === 'occasional') f.push(['warn', 'Occasional interior stains', 'Minor stains can mean a small active leak worth tracing.']);
    else if (m === 'active') f.push(['bad', 'Active leak reported', 'Water is getting in now — this should be looked at promptly.']);
    else if (m === 'noaccess') f.push(['warn', 'Attic not accessible', 'Hard to rule out hidden moisture without a look.']);
    // maintenance
    if (S.lastInspect === 'recent') f.push(['good', 'Inspected within 2 years', 'Recent professional eyes on it is a plus.']);
    else if (S.lastInspect === 'never') f.push(['warn', 'No recent inspection', '5+ years (or never) means small issues can go unnoticed.']);
    return f;
  }
  function recoFor(key) {
    var FIN = '<a href="/services/financing" style="color:var(--orange-dark);font-weight:700">flexible financing options</a>';
    if (key === 'excellent') return '<b>Joe’s recommendation:</b> Your roof is in good shape — keep it that way with a quick check every couple of years and after any major storm. Want a baseline for your records? Joe will do a free inspection, no strings.';
    if (key === 'good') return '<b>Joe’s recommendation:</b> Solid overall. A few items are worth monitoring so small problems don’t become big ones. A free once-over from Joe confirms you’re good and flags anything early.';
    if (key === 'fair') return '<b>Joe’s recommendation:</b> Your roof is showing real wear — it’s the right time for a professional look before minor issues turn into leaks. Joe documents what he finds and gives you a straight, no-pressure recommendation.';
    if (key === 'poor') return '<b>Joe’s recommendation:</b> Several warning signs are stacking up — don’t wait. A free inspection now can save you from interior damage later. If replacement makes sense, Joe lays out every option (including ' + FIN + ') with no hard sell.';
    return '<b>Joe’s recommendation:</b> The answers point to a roof at or near the end of its life. Get eyes on it soon — Joe documents everything (important if a storm was involved and insurance is in play) and walks you through repair vs. replacement and ' + FIN + ', honestly.';
  }

  /* ── gauge render ── */
  function paintGauge(gid, nid, score, color) {
    var g = $(gid); if (g) g.style.background = 'conic-gradient(' + color + ' 0 ' + score + '%, var(--light-gray) ' + score + '% 100%)';
    var n = $(nid); if (n) n.textContent = score;
  }

  /* ── compute + show free band (split-gate: score free, report gated) ── */
  function showBand() {
    if (!validate(4)) return;
    var score = computeScore(); var band = bandFor(score);
    S.score = score; S.band = band;
    paintGauge('rs-gauge', 'rs-score-num', score, band.color);
    var bl = $('rs-band-label'); if (bl) { bl.textContent = band.label; bl.style.color = band.color; }
    var bs = $('rs-band-summary'); if (bs) bs.textContent = band.summary;
    showOnly('rs-band'); setProgress(100);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (window.gtag) window.gtag('event', 'roof_score_band', { score: score, band: band.key });
  }

  /* ── Joe's take (best-effort AI, graceful fallback) ── */
  function joesTake() {
    var fb = (S.firstName || 'Hey') + ', thanks for running the numbers on your roof. Whatever the score says, the honest next step is the same: I’ll take a free look, tell you exactly where it stands, and lay out your options with zero pressure.';
    try {
      var prompt = 'You are Joe Deal, owner of No Big Deal Home Solutions, a straight-talking Cincinnati roofer. Write a warm, 2-sentence, no-BS note to ' +
        (S.firstName || 'a homeowner') + ' who just got a Roof Health Score of ' + S.score + '/100 (' + (S.band && S.band.label) + '). Roof age: ' + S.roofAge +
        ', material: ' + S.roofType + ', signs: ' + (S.signs.join(', ') || 'none') + ', interior moisture: ' + S.moisture +
        '. Offer a free inspection. Do NOT guarantee any condition, claim approval, or mention any dollar amounts.';
      return fetch(PROXY, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt, maxTokens: 180 })
      }).then(function (r) { return r.json(); }).then(function (d) {
        var txt = d && d.text; return (txt && txt.trim()) ? txt.trim() : fb;
      }).catch(function () { return fb; });
    } catch (e) { return Promise.resolve(fb); }
  }

  /* ── shared intake block (2026-09-30, Jo: every service form asks the same):
     REQUIRED scheduling choice, best time, insurance, how-heard, photos —
     intake-extras.js. If the block never loaded, the lead is never blocked. ── */
  var IP = 'rsI';
  function mountIntake() {
    var box = $('rs-intake');
    if (!box || box.childElementCount) return true;
    if (!window.NBDIntake) return false;
    box.innerHTML = window.NBDIntake.html(IP);
    return true;
  }
  function readIntake() {
    var box = $('rs-intake');
    if (!window.NBDIntake || !box || !box.childElementCount) return { fields: {}, files: [] };
    return window.NBDIntake.read(box, IP);
  }
  function afterIntake(res, boxId) {
    if (!window.NBDIntake || !S.intake || !(res && res.ok)) return;
    window.NBDIntake.afterSubmit($(boxId), { prefix: IP, fields: S.intake.fields, files: S.intake.files, photoToken: res.photoToken || null,
      firstName: S.firstName || '', phone: S.phone || '', email: S.email || '', address: S.address || '', service: 'Roof inspection' });
  }

  /* ── submit (unlock report) ── */
  function submitLead() {
    var fn = $('rs-firstName').value.trim(), ph = $('rs-phone').value.trim(),
        em = $('rs-email').value.trim(), consent = $('rs-consent').checked;
    if (!fn || ph.replace(/\D/g, '').replace(/^1/, '').length !== 10) { $('rs-contact-err').textContent = 'Please add your name and a 10-digit phone.'; return; }
    if (!consent) { $('rs-contact-err').textContent = 'Please check the consent box so Joe can reach you.'; return; }
    var intake = readIntake();
    if (intake.error) { $('rs-contact-err').textContent = intake.error; if (intake.el && intake.el.classList) intake.el.classList.add('nbd-intake-invalid'); return; }
    S.intake = intake;
    $('rs-contact-err').textContent = '';
    S.firstName = fn; S.phone = ph; S.email = em;
    var btn = $('rs-submit'); btn.disabled = true; btn.textContent = 'Building…';

    var story = 'ROOF SCORE ' + S.score + '/100 (' + (S.band && S.band.label) + ') | age: ' + S.roofAge +
      ' (' + S.roofType + ') | signs: ' + (S.signs.join(', ') || 'none') + ' | moisture: ' + S.moisture +
      ' | last inspect: ' + S.lastInspect;
    // tcpaConsent: the checkbox's real value, persisted server-side so the SMS ack
    // gates on a stored record (TCPA fix, 2026-09-04; see #1377).
    var payload = { name: fn, phone: ph, address: S.address || $('rs-address').value.trim(), source: '/roof-score', story: story, tcpaConsent: consent === true };
    if (em) payload.email = em;
    Object.assign(payload, S.intake.fields);
    var capture = (typeof window.submitPublicLead === 'function')
      ? window.submitPublicLead('inspect', payload)
      : Promise.resolve({ ok: false });

    showOnly('rs-loading');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    Promise.all([capture, joesTake()]).then(function (res) {
      var lead = res[0], take = res[1];
      S.submitted = !!(lead && lead.ok);
      renderReport(take, lead);
      afterIntake(lead, 'rs-intake-after');
    });
  }
  function renderReport(take, lead) {
    paintGauge('rs-gauge2', 'rs-score-num2', S.score, S.band.color);
    var bl = $('rs-band-label2'); if (bl) { bl.textContent = S.band.label; bl.style.color = S.band.color; }
    var ICON = { good: '✓', warn: '!', bad: '✕' };
    var list = buildFactors().map(function (f) {
      return '<li class="rs-factor ' + f[0] + '"><span class="rs-fico">' + ICON[f[0]] + '</span>' +
        '<span><strong>' + f[1] + '</strong><span>' + f[2] + '</span></span></li>';
    }).join('');
    $('rs-factors').innerHTML = list;
    $('rs-reco').innerHTML = recoFor(S.band.key);
    $('rs-take').textContent = take;
    if (!(lead && lead.ok)) {
      var w = $('rs-report-warn');
      if (w) { w.style.display = 'block'; w.textContent = 'Heads up: we couldn’t auto-save your info — please call or text Joe at (859) 420-7382 so it isn’t lost.'; }
    }
    showOnly('rs-report');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (window.gtag) window.gtag('event', 'roof_score_report', { score: S.score, band: S.band.key });
  }

  /* ── phone formatting ── */
  function wirePhone() {
    var el = $('rs-phone'); if (!el) return;
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
      var act = e.target.closest('[data-action]');
      if (act) {
        if (act.dataset.action === 'calc') { showBand(); return; }
        if (act.dataset.action === 'submit') { submitLead(); return; }
      }
      var step = e.target.closest('[data-step]'); if (step) { goToStep(+step.dataset.step); return; }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
