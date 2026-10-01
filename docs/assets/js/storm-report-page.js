/* storm-report-page.js — /storm-report "Storm History Report" funnel.
 * address -> GET /api/storm-report (server proxy, NWS/IEM 5-yr data) ->
 * FREE teaser (counts) -> gate (name+phone, captured via submitPublicLead
 * 'inspect' source=/storm-report) -> full report (event table + Leaflet
 * map + claim verdict + Joe CTA + Save-as-PDF).
 * Compliance: storm DATA, not an insurance determination; verdict stays
 * "worth a free inspection," never "your claim will pay."
 */
(function () {
  'use strict';
  var API = window.__NBD_STORM_API || '/api/storm-report';
  var $ = function (id) { return document.getElementById(id); };
  var S = { address: '', lat: null, lon: null, data: null };

  /* ── address autocomplete (Nominatim, Cincinnati-biased) ── */
  var deb = null, seq = 0;
  function wireAddress() {
    var inp = $('sr-address'), drop = $('sr-acdrop');
    if (!inp) return;
    inp.addEventListener('input', function () {
      S.lat = S.lon = null; S.address = '';
      clearTimeout(deb);
      var q = this.value.trim();
      if (q.length < 4) { drop.style.display = 'none'; return; }
      deb = setTimeout(function () { searchAddr(q); }, 350);
    });
    document.addEventListener('click', function (e) { if (!e.target.closest('.sr-input-wrap')) drop.style.display = 'none'; });
  }
  function searchAddr(q) {
    var drop = $('sr-acdrop'), my = ++seq;
    fetch('https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(q) +
      '&format=json&addressdetails=1&countrycodes=us&limit=5&viewbox=' +
      encodeURIComponent('-85.2,39.5,-83.6,38.6') + '&bounded=0')
      .then(function (r) { return r.json(); }).then(function (data) {
        if (my !== seq) return;
        if (!data.length) { drop.style.display = 'none'; return; }
        window._srAc = data;
        drop.innerHTML = data.map(function (d, i) { return '<div class="sr-ac-item" data-idx="' + i + '">' + String(d.display_name).replace(/[<>]/g, '') + '</div>'; }).join('');
        drop.style.display = 'block';
      }).catch(function () { if (my === seq) drop.style.display = 'none'; });
  }
  function pickAddr(i) {
    var d = (window._srAc || [])[i]; if (!d) return;
    S.address = d.display_name; S.lat = parseFloat(d.lat); S.lon = parseFloat(d.lon);
    $('sr-address').value = d.display_name; $('sr-acdrop').style.display = 'none';
    $('sr-addr-hint').style.display = 'none';
  }

  /* ── step 1: generate (fetch the report) ── */
  function generate() {
    if (S.lat == null) { var h = $('sr-addr-hint'); h.textContent = 'Type your address and pick it from the dropdown.'; h.style.display = 'block'; return; }
    show('sr-loading');
    fetch(API + '?lat=' + S.lat + '&lon=' + S.lon)
      .then(function (r) { return r.json(); })
      .then(function (j) { S.data = j; renderTeaser(); show('sr-teaser'); })
      .catch(function () {
        // graceful fail — still let them request an inspection
        S.data = { counts: { total: 0, hail: 0, wind: 0, tornado: 0, stormDays: 0 }, events: [], _err: true };
        renderTeaser(); show('sr-teaser');
      });
    if (window.gtag) window.gtag('event', 'storm_report_generate');
  }
  function nearWithin(mi) { return (S.data.events || []).filter(function (e) { return e.distanceMi <= mi; }); }
  function renderTeaser() {
    var c = S.data.counts || {};
    var within10 = nearWithin(10);
    var h10 = within10.filter(function (e) { return e.type === 'hail'; }).length;
    var headline = (c.total > 0)
      ? 'We found ' + c.total + ' storm events near this address'
      : 'No major storm reports logged near this address';
    $('sr-teaser-headline').textContent = headline;
    $('sr-teaser-sub').textContent = (c.total > 0)
      ? 'Over the last ' + (S.data.years || 5) + ' years within ' + (S.data.radiusMi || 30) + ' miles — ' +
        (c.hail || 0) + ' hail, ' + (c.wind || 0) + ' wind, ' + (c.tornado || 0) + ' tornado' +
        (S.data.maxHail ? ' · hail up to ' + S.data.maxHail + '″' : '') + '.'
      : 'That doesn’t rule out damage — a free inspection is the only way to be sure.';
    $('sr-teaser-chips').innerHTML =
      chip('🧊 ' + (c.hail || 0) + ' hail') + chip('💨 ' + (c.wind || 0) + ' wind') +
      chip('🌪️ ' + (c.tornado || 0) + ' tornado') + chip('📅 ' + (c.stormDays || 0) + ' storm days') +
      (h10 ? chip('📍 ' + h10 + ' hail within 10 mi') : '');
  }
  function chip(t) { return '<span class="sr-chip">' + t + '</span>'; }

  /* ── shared intake block (2026-09-30, Jo: every service form asks the same):
     REQUIRED scheduling choice, best time, insurance, how-heard, photos —
     intake-extras.js. If the block never loaded, the lead is never blocked. ── */
  var IP = 'srI';
  function mountIntake() {
    var box = $('sr-intake');
    if (!box || box.childElementCount) return true;
    if (!window.NBDIntake) return false;
    box.innerHTML = window.NBDIntake.html(IP);
    return true;
  }
  function readIntake() {
    var box = $('sr-intake');
    if (!window.NBDIntake || !box || !box.childElementCount) return { fields: {}, files: [] };
    return window.NBDIntake.read(box, IP);
  }
  function afterIntake(res, boxId) {
    if (!window.NBDIntake || !S.intake || !(res && res.ok)) return;
    window.NBDIntake.afterSubmit($(boxId), { prefix: IP, fields: S.intake.fields, files: S.intake.files, photoToken: res.photoToken || null,
      firstName: S.firstName || '', phone: S.phone || '', email: S.email || '', address: S.address || '', service: 'Roof inspection' });
  }

  /* ── gate -> capture -> full report ── */
  function unlock() {
    var fn = $('sr-firstName').value.trim(), ph = $('sr-phone').value.trim(), em = $('sr-email').value.trim();
    if (!fn || ph.replace(/\D/g, '').replace(/^1/, '').length !== 10) { $('sr-gate-err').textContent = 'Please add your name and a 10-digit phone.'; return; }
    if (!$('sr-consent').checked) { $('sr-gate-err').textContent = 'Please check the box so Joe can send your report.'; return; }
    var intake = readIntake();
    if (intake.error) { $('sr-gate-err').textContent = intake.error; if (intake.el && intake.el.classList) intake.el.classList.add('nbd-intake-invalid'); return; }
    S.intake = intake;
    S.firstName = fn; S.phone = ph; S.email = em;
    $('sr-gate-err').textContent = '';
    var btn = $('sr-unlock'); btn.disabled = true; btn.textContent = 'Building your report…';
    var c = S.data.counts || {};
    var story = 'STORM REPORT | ' + (c.total || 0) + ' events/' + (S.data.years || 5) + 'yr (' +
      (c.hail || 0) + ' hail, ' + (c.wind || 0) + ' wind, ' + (c.tornado || 0) + ' tornado, max ' + (S.data.maxHail || 0) + '″)';
    // tcpaConsent: the checkbox's real value, persisted server-side so the SMS ack
    // gates on a stored record (TCPA fix, 2026-09-04; see #1377).
    var payload = { name: fn, phone: ph, address: S.address, source: '/storm-report', story: story, tcpaConsent: $('sr-consent').checked === true };
    if (em) payload.email = em;
    Object.assign(payload, S.intake.fields);
    var cap = (typeof window.submitPublicLead === 'function') ? window.submitPublicLead('inspect', payload) : Promise.resolve({ ok: false });
    cap.then(function (res) { renderReport(res && res.ok); afterIntake(res, 'sr-intake-after'); });
    if (window.gtag) window.gtag('event', 'storm_report_unlock');
  }
  function verdict() {
    var c = S.data.counts || {}, near = nearWithin(10);
    var hailNear = near.filter(function (e) { return e.type === 'hail'; }).length;
    var sev = (S.data.events || []).some(function (e) { return e.severity === 'severe'; });
    if ((hailNear || c.tornado) && sev) return { h: 'Strong claim potential — get it documented.', d: 'Severe storm activity this close to your home is exactly what insurers act on. Joe inspects free, documents the damage, and meets your adjuster on the roof — the claim stays yours.' };
    if (c.hail || c.tornado || c.wind > 3) return { h: 'Worth a free inspection.', d: 'There’s real storm history here. Joe will get on the roof, document anything claimable, and tell you straight whether it’s worth filing.' };
    return { h: 'A free inspection is the only way to be sure.', d: 'Light storm history on record near you — but damage isn’t always obvious from the ground. Joe checks it free, no obligation.' };
  }
  function renderReport(saved) {
    var c = S.data.counts || {}, v = verdict();
    $('sr-rep-headline').textContent = v.h;
    $('sr-rep-detail').textContent = v.d;
    $('sr-rep-summary').innerHTML =
      stat(c.total || 0, 'storm events') + stat(c.hail || 0, 'hail') + stat(c.wind || 0, 'wind') +
      stat(c.tornado || 0, 'tornado') + stat((S.data.maxHail || 0) + '″', 'max hail');
    // notable events: hail + tornado + severe/significant wind, newest first, cap 25
    var notable = (S.data.events || []).filter(function (e) { return e.type !== 'wind' || e.severity !== 'minor'; }).slice(0, 25);
    if (!notable.length) notable = (S.data.events || []).slice(0, 15);
    $('sr-rep-rows').innerHTML = notable.map(function (e) {
      return '<tr><td>' + fmtDate(e.date) + '</td><td><span class="sr-tag sr-' + e.type + '">' + e.type + '</span></td><td>' +
        (e.magnitude ? e.magnitude + (e.unit ? e.unit : '') : '—') + '</td><td>' + e.distanceMi + ' mi</td></tr>';
    }).join('') || '<tr><td colspan="4" style="text-align:center;color:#5d6673">No individual reports on file near this address.</td></tr>';
    $('sr-rep-source').textContent = 'Source: ' + (S.data.source || 'NWS Local Storm Reports (NOAA)') + '. Report range: ' + (S.data.years || 5) + ' years within ' + (S.data.radiusMi || 30) + ' miles.';
    if (!saved) { var w = $('sr-rep-warn'); w.style.display = 'block'; w.textContent = 'Note: we couldn’t auto-save your info — please call/text Joe at (859) 420-7382 so your report request isn’t lost.'; }
    show('sr-report');
    initMap();
    if (window.gtag) window.gtag('event', 'storm_report_complete', { events: c.total || 0 });
  }
  function stat(v, l) { return '<div class="sr-stat"><b>' + v + '</b><span>' + l + '</span></div>'; }
  function fmtDate(s) { try { return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) { return '—'; } }

  /* ── Leaflet map (OSM tiles — reliable, not Brave-blocked) ── */
  function initMap() {
    if (S.lat == null) return;
    if (typeof L === 'undefined') { loadLeaflet(drawMap); } else { drawMap(); }
  }
  function loadLeaflet(cb) {
    if (!$('lf-css')) { var c = document.createElement('link'); c.id = 'lf-css'; c.rel = 'stylesheet'; c.href = '/assets/vendor/leaflet/leaflet.css'; document.head.appendChild(c); }
    if (!$('lf-js')) { var s = document.createElement('script'); s.id = 'lf-js'; s.src = '/assets/vendor/leaflet/leaflet.js'; s.onload = cb; s.onerror = function () { var m = $('sr-map'); if (m) m.style.display = 'none'; }; document.head.appendChild(s); }
    else cb();
  }
  function drawMap() {
    var el = $('sr-map'); if (!el || el._init) return; el._init = true;
    var map = L.map('sr-map', { scrollWheelZoom: false }).setView([S.lat, S.lon], 10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 18 }).addTo(map);
    L.circleMarker([S.lat, S.lon], { radius: 8, color: '#12223d', fillColor: '#bd5728', fillOpacity: 1, weight: 3 }).addTo(map).bindPopup('Your property');
    var col = { hail: '#2563eb', wind: '#16a34a', tornado: '#dc2626' };
    (S.data.events || []).forEach(function (e) {
      if (e.lat == null) return;
      L.circleMarker([e.lat, e.lon], { radius: 4, color: col[e.type] || '#888', fillColor: col[e.type] || '#888', fillOpacity: .6, weight: 1 })
        .addTo(map).bindPopup(e.type + (e.magnitude ? ' ' + e.magnitude + e.unit : '') + ' · ' + fmtDate(e.date));
    });
  }

  /* ── helpers ── */
  function show(id) { document.querySelectorAll('.sr-panel').forEach(function (p) { p.classList.remove('active'); }); var t = $(id); if (t) t.classList.add('active'); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  function wirePhone() { var el = $('sr-phone'); if (!el) return; el.addEventListener('input', function () { var v = this.value.replace(/\D/g, '').slice(0, 10); if (v.length >= 7) this.value = '(' + v.slice(0, 3) + ') ' + v.slice(3, 6) + '-' + v.slice(6); else if (v.length >= 4) this.value = '(' + v.slice(0, 3) + ') ' + v.slice(3); else this.value = v; }); }
  function wire() {
    wireAddress(); wirePhone();
    if (!mountIntake()) { var _it = 0, _iv = setInterval(function () { if (mountIntake() || ++_it > 40) clearInterval(_iv); }, 250); }
    document.addEventListener('click', function (e) {
      var ac = e.target.closest('.sr-ac-item[data-idx]'); if (ac) { pickAddr(+ac.dataset.idx); return; }
      var act = e.target.closest('[data-action]'); if (!act) return;
      var a = act.dataset.action;
      if (a === 'generate') generate();
      else if (a === 'unlock') unlock();
      else if (a === 'print') window.print();
      else if (a === 'restart') { S.data = null; show('sr-step1'); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
