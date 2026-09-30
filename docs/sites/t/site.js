/**
 * /sites/t/ — universal tenant microsite renderer (Pillar 5 phase 1).
 *
 * One static template, N tenants: the company key comes from the URL
 * (/sites/t/<companyId-or-slug>, or ?c=<key> as a fallback), the brand
 * comes from /api/site-config (a server-side, whitelisted read of the
 * tenant's companyProfile), and the quote form posts through the same
 * hardened submitPublicLead gateway every public NBD form uses — tagged
 * with the tenant's public siteKey (the slug when configured; P5
 * indirection 2026-08-06 — the uid no longer round-trips the client),
 * which the gateway resolves server-side so the lead lands in THEIR
 * pipeline and alerts THEIR inbox (lead-alert resolveAlertTarget),
 * never Joe's.
 *
 * Everything tenant-typed is escaped or set via textContent; colors are
 * validated before being installed as CSS custom properties.
 */
(function () {
  'use strict';

  // Emulator rig (localhost only): point the shared lead gateway at the
  // local Functions emulator so the quote form works end-to-end in tests.
  // This page is a plain script, so it can't import nbd-emulator-connect.js —
  // same hostname guard, hard no-op in production.
  if (/^(localhost|127\.0\.0\.1|\[::1\]|::1)$/.test(window.location.hostname) && !window.__NBD_FUNCTIONS_BASE) {
    window.__NBD_FUNCTIONS_BASE = 'http://127.0.0.1:5001/nobigdeal-pro/us-central1';
  }

  var $ = function (id) { return document.getElementById(id); };

  function companyKey() {
    // /sites/t/<key>[/...] — the hosting rewrite serves this page for any
    // path under /sites/t/.
    var m = window.location.pathname.match(/\/sites\/t\/([A-Za-z0-9_-]{1,64})/);
    if (m) return m[1];
    var q = new URLSearchParams(window.location.search).get('c') || '';
    return /^[A-Za-z0-9_-]{1,64}$/.test(q) ? q : '';
  }

  var COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
  function applyColors(colors) {
    var root = document.documentElement;
    if (colors && COLOR_RE.test(colors.primary || '')) root.style.setProperty('--primary', colors.primary);
    if (colors && COLOR_RE.test(colors.accent || '')) root.style.setProperty('--accent', colors.accent);
  }

  function telHref(phone) {
    var d = String(phone || '').replace(/[^\d]/g, '');
    return d ? 'tel:' + (d.length === 10 ? '1' + d : d) : '';
  }

  var FALLBACK_SERVICES = [
    { icon: '🏠', name: 'Roofing', desc: 'Repairs, full replacements, and storm damage.' },
    { icon: '🧱', name: 'Siding', desc: 'Repair and replacement.' },
    { icon: '🌧️', name: 'Gutters', desc: 'Seamless gutters, guards, and drainage.' }
  ];

  function render(cfg) {
    var name = cfg.displayName || cfg.name;
    document.title = name + (cfg.serviceArea ? ' — ' + cfg.serviceArea : '');
    applyColors(cfg.colors);

    $('brandName').textContent = name;
    if (cfg.logoUrl) {
      var logo = $('brandLogo');
      logo.src = cfg.logoUrl;
      logo.alt = name + ' logo';
      logo.hidden = false;
    }
    $('heroName').textContent = cfg.name;
    if (cfg.tagline) { $('heroTagline').textContent = cfg.tagline; $('heroTagline').hidden = false; }
    if (cfg.serviceArea) {
      $('heroArea').textContent = 'Serving ' + cfg.serviceArea;
      $('heroArea').hidden = false;
      $('areaText').textContent = cfg.serviceArea;
      $('areaSection').hidden = false;
    }

    var phone = cfg.contact && cfg.contact.phone;
    if (phone && telHref(phone)) {
      var nav = $('navPhone');
      nav.textContent = '📞 ' + phone;
      nav.href = telHref(phone);
      nav.hidden = false;
      var call = $('heroCall');
      call.textContent = 'Call ' + phone;
      call.href = telHref(phone);
      call.hidden = false;
    }

    var services = (cfg.services && cfg.services.length) ? cfg.services : FALLBACK_SERVICES;
    var grid = $('servicesGrid');
    var select = $('qService');
    services.forEach(function (sv) {
      var card = document.createElement('div');
      card.className = 't-service';
      var ico = document.createElement('div'); ico.className = 'ico'; ico.textContent = sv.icon || '🔨';
      var h = document.createElement('h3'); h.textContent = sv.name;
      var p = document.createElement('p'); p.textContent = sv.desc || '';
      card.appendChild(ico); card.appendChild(h); card.appendChild(p);
      grid.appendChild(card);
      var opt = document.createElement('option');
      opt.value = sv.name; opt.textContent = sv.name;
      select.appendChild(opt);
    });

    var footBits = [];
    if (cfg.contact) {
      if (cfg.contact.address) footBits.push(cfg.contact.address);
      if (phone) footBits.push(phone);
      if (cfg.contact.email) footBits.push(cfg.contact.email);
    }
    $('footIdentity').textContent = '© ' + new Date().getFullYear() + ' ' + cfg.name;
    $('footContact').textContent = footBits.join(' · ');

    $('siteLoading').hidden = true;
    $('site').hidden = false;
  }

  function showMissing() {
    $('siteLoading').hidden = true;
    $('siteMissing').hidden = false;
  }

  function wireForm(cfg) {
    var form = $('quoteForm');
    if (!form) return;
    // Intake block in the contractor's own words: their name and phone, no
    // NBD calendar (a microsite has no booking link, so the required
    // scheduling choice is "please contact me").
    var intakeBox = $('qIntake');
    var cPhone = (cfg.contact && cfg.contact.phone) || '';
    var cTel = cPhone.replace(/[^0-9+]/g, '');
    if (intakeBox && window.NBDIntake) {
      intakeBox.innerHTML = window.NBDIntake.html('tq', {
        who: cfg.displayName || cfg.name || 'We',
        phoneTel: cTel || null, phoneDisplay: cPhone || null, calUrl: null
      });
    }
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var errEl = $('formErr'); var okEl = $('formOk');
      errEl.textContent = ''; okEl.textContent = '';
      var firstName = $('qFirst').value.trim();
      var phone = $('qPhone').value.trim();
      var address = $('qAddress').value.trim();
      // Shared public-form rules: a 10-digit phone and a street address.
      var phoneOk = phone.replace(/\D/g, '').replace(/^1/, '').length === 10;
      var addressOk = address.length >= 6 && /\d/.test(address) && /[a-z]/i.test(address);
      if (!firstName || !phoneOk || !addressOk) { errEl.textContent = 'Please add your first name, a 10-digit phone number, and your street address.'; return; }
      var intake = { fields: {}, files: [] };
      if (window.NBDIntake) {
        intake = window.NBDIntake.read(form, 'tq');
        if (intake.error) {
          if (intake.el && intake.el.classList) intake.el.classList.add('nbd-intake-invalid');
          errEl.textContent = intake.error;
          return;
        }
      }
      var btn = $('qSubmit');
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        if (typeof window.submitPublicLead !== 'function') {
          throw new Error('form gateway not loaded — please call instead');
        }
        var out = await window.submitPublicLead('contact', Object.assign({
          firstName: firstName,
          lastName: $('qLast').value.trim(),
          phone: phone,
          email: $('qEmail').value.trim(),
          address: address,
          service: $('qService').value,
          message: $('qMessage').value.trim(),
          nbd_hp: $('qHoneypot').value, // honeypot — humans leave it empty
          // P5 indirection: tag with the public siteKey (the slug when
          // configured) — the gateway resolves it server-side. The
          // cfg.companyId fallback covers a cached pre-P5 API response
          // during the deploy-skew window.
          siteKey: cfg.siteKey || cfg.companyId,
          source: 'tenant-site:' + (cfg.siteKey || cfg.companyId)
        }, intake.fields));
        if (!out || !out.ok) throw new Error((out && out.reason) || 'submission failed');
        okEl.textContent = "Got it! " + (cfg.displayName || cfg.name) + " will reach out shortly.";
        btn.textContent = 'Sent ✓';
        if (window.NBDIntake) {
          await window.NBDIntake.afterSubmit(okEl.parentNode, {
            prefix: 'tq', fields: intake.fields, files: intake.files, photoToken: out.photoToken || null,
            firstName: firstName, phone: phone, address: address
          });
        }
        form.reset();
      } catch (err) {
        errEl.textContent = 'Could not send your request — ' + (err.message || 'try again') +
          (cfg.contact && cfg.contact.phone ? '. Or call ' + cfg.contact.phone + '.' : '.');
        btn.disabled = false; btn.textContent = 'Send my request';
      }
    });
  }

  async function boot() {
    var key = companyKey();
    if (!key) { showMissing(); return; }
    try {
      var res = await fetch('/api/site-config?company=' + encodeURIComponent(key));
      if (!res.ok) { showMissing(); return; }
      var cfg = await res.json();
      if (!cfg || !cfg.ok || !cfg.name) { showMissing(); return; }
      render(cfg);
      wireForm(cfg);
    } catch (_) {
      showMissing();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
