/* Quick on-page lead form — self-configuring (2026-07-03, conversion audit).
 * Service/city pages used to bounce "Get My Free Estimate" to the homepage
 * /#contact, leaking intent. This renders a short form IN PLACE and posts
 * through the same hardened submitPublicLead gateway (App Check + rate limit +
 * honeypot) every NBD public form uses — tagged with the page's service/city
 * so the lead lands in Joe's pipeline with context, no navigation required.
 *
 * Usage: <div data-nbd-quick-form data-service="Hail Damage" data-city="Mason"></div>
 * Required (2026-09-30, Jo): first name, a 10-digit phone, the street address,
 * and a scheduling choice (book a time now / please contact me). Email is
 * optional. Photos, best time, insurance and how-heard come from
 * intake-extras.js, lazy-loaded like the gateway client.
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Lazy-load the shared gateway client if a page didn't include it.
  function ensureGateway() {
    if (typeof window.submitPublicLead === 'function') return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = '/assets/js/public-lead-submit.js';
      s.onload = resolve;
      s.onerror = function () { reject(new Error('gateway load failed')); };
      document.head.appendChild(s);
    });
  }

  // The live Google rating for the trust line (data-nbd-gr-rating). Pages that
  // already load google-reviews-widget.js get re-hydrated through its hook;
  // the rest load it once. Until it answers, the static "5.0" stands — the
  // same true-at-rest fallback the homepage's reviews row uses.
  function hydrateRating() {
    if (typeof window.nbdHydrateReviewHooks === 'function') { window.nbdHydrateReviewHooks(); return; }
    if (document.querySelector('script[src*="google-reviews-widget.js"]')) return; // loading — it hydrates on its own
    var s = document.createElement('script');
    s.src = '/assets/js/google-reviews-widget.js';
    s.defer = true;
    document.head.appendChild(s);
  }

  // Lazy-load the shared intake block (scheduling choice, photos, …).
  function ensureIntake() {
    if (window.NBDIntake) return Promise.resolve();
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = '/assets/js/intake-extras.js?v=1';
      s.onload = resolve;
      s.onerror = function () { resolve(); }; // form still works without it
      document.head.appendChild(s);
    });
  }

  function render(host) {
    var service = host.getAttribute('data-service') || '';
    var city = host.getAttribute('data-city') || '';
    var uid = 'qlf-' + Math.abs((service + city + host.offsetTop).split('').reduce(function (a, c) { return (a * 31 + c.charCodeAt(0)) | 0; }, 7));
    var heading = city ? ('Get Your Free ' + esc(city) + ' Estimate') : 'Get Your Free Estimate';
    var sub = service
      ? ('Tell Joe where and he\'ll reach out — usually same day. Or just call.')
      : ('Tell Joe where and he\'ll reach out — usually same day.');
    host.innerHTML =
      '<form class="qlf" novalidate aria-labelledby="' + uid + '-h">' +
        '<h3 class="qlf-title" id="' + uid + '-h">' + heading + '</h3>' +
        '<p class="qlf-sub">' + sub + '</p>' +
        '<div class="qlf-msg qlf-err" id="' + uid + '-err" role="alert"></div>' +
        '<div class="qlf-msg qlf-ok" id="' + uid + '-ok" role="status"></div>' +
        '<div class="qlf-row">' +
          '<label class="qlf-field"><span>First name *</span><input id="' + uid + '-fn" type="text" name="given-name" autocomplete="given-name" required></label>' +
          '<label class="qlf-field"><span>Mobile phone *</span><input id="' + uid + '-ph" type="tel" name="tel" autocomplete="tel" inputmode="tel" required></label>' +
        '</div>' +
        '<label class="qlf-field"><span>Street address *</span><input id="' + uid + '-ad" type="text" name="street-address" autocomplete="street-address" placeholder="123 Main St, City" required></label>' +
        '<label class="qlf-field"><span>Email <em>(optional)</em></span><input id="' + uid + '-em" type="email" name="email" autocomplete="email" inputmode="email"></label>' +
        '<div data-nbd-intake="' + uid + 'i"></div>' +
        // Honeypot — the gateway drops any submission that fills this. Named
        // nbd_hp, NOT "website": that name matches browser URL-autofill
        // heuristics, and an autofilled honeypot silently drops a real lead.
        '<input class="qlf-hp" id="' + uid + '-hp" type="text" name="nbd_hp" tabindex="-1" autocomplete="off" aria-hidden="true">' +
        // TCPA (2026-10-03): the express-written-consent box /storm-check uses,
        // same wording; required, and posted as tcpaConsent for the record.
        '<label class="sc-consent"><input type="checkbox" id="' + uid + '-consent"><span>I agree to receive my results and follow-up communication from No Big Deal Home Solutions by call or text at the number above. Message &amp; data rates may apply. Reply STOP to opt out. Not a condition of purchase.</span></label>' +
        // Trust line above Submit (2026-10-03). Rating hydrated live (hydrateRating).
        '<p class="qlf-trust"><span aria-hidden="true">&#9733;</span> <span data-nbd-gr-rating>5.0</span> on Google &middot; Licensed &amp; insured &middot; Joe on every roof</p>' +
        '<button class="qlf-btn" type="submit" id="' + uid + '-btn">Send &mdash; Joe calls you back</button>' +
        '<div class="qlf-alt">Rather talk now? <a href="tel:+18594207382">Call or text (859) 420-7382</a></div>' +
      '</form>';

    var form = host.querySelector('form');
    var err = document.getElementById(uid + '-err');
    var ok = document.getElementById(uid + '-ok');
    var btn = document.getElementById(uid + '-btn');
    ensureIntake();
    hydrateRating();
    // First focus in the form: fetch the gateway client now, not at Submit —
    // loading it starts the spam-check (Turnstile) script download too
    // (public-lead-submit.js preloads on the focused field).
    form.addEventListener('focusin', function () { ensureGateway().catch(function () {}); }, { once: true });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      err.textContent = ''; ok.textContent = '';
      var firstName = document.getElementById(uid + '-fn').value.trim();
      var phone = document.getElementById(uid + '-ph').value.trim();
      var address = document.getElementById(uid + '-ad').value.trim();
      var email = document.getElementById(uid + '-em').value.trim();
      // Shared public-form phone rule: digits only, leading 1 dropped, exactly 10.
      var phoneOk = phone.replace(/\D/g, '').replace(/^1/, '').length === 10;
      var addressOk = address.length >= 6 && /\d/.test(address) && /[a-z]/i.test(address);
      if (!firstName || !phoneOk || !addressOk) {
        err.textContent = 'Please add your first name, a 10-digit phone number, and your street address.';
        return;
      }
      var consentEl = document.getElementById(uid + '-consent');
      var consent = !!(consentEl && consentEl.checked);
      if (!consent) {
        err.textContent = 'Please check the consent box so Joe can reach you.';
        return;
      }
      var intake = { fields: {}, files: [] };
      if (window.NBDIntake) {
        intake = window.NBDIntake.read(form, uid + 'i');
        if (intake.error) {
          if (intake.el && intake.el.classList) intake.el.classList.add('nbd-intake-invalid');
          err.textContent = intake.error;
          return;
        }
      }
      btn.disabled = true; btn.textContent = 'Sending…';
      ensureGateway().then(function () {
        return window.submitPublicLead('contact', Object.assign({
          firstName: firstName,
          phone: phone,
          address: address,
          email: email,
          service: service,
          message: (service || city) ? ('Page: ' + [service, city].filter(Boolean).join(' — ')) : '',
          nbd_hp: document.getElementById(uid + '-hp').value, // honeypot
          tcpaConsent: consent === true,
          source: 'page-form:' + (window.location.pathname || '')
        }, intake.fields));
      }).then(function (out) {
        if (!out || !out.ok) throw new Error((out && out.reason) || 'failed');
        ok.textContent = 'Got it! Joe will reach out shortly — usually same day.';
        btn.textContent = 'Sent ✓';
        if (window.NBDIntake) {
          window.NBDIntake.afterSubmit(ok.parentNode, {
            prefix: uid + 'i', fields: intake.fields, files: intake.files, photoToken: out.photoToken || null,
            firstName: firstName, phone: phone, email: email, address: address, service: service
          }).then(function () { form.reset(); });
        } else {
          form.reset();
        }
      }).catch(function (e2) {
        err.textContent = 'Could not send — please call or text (859) 420-7382. (' + (e2.message || 'error') + ')';
        btn.disabled = false; btn.textContent = 'Send — Joe calls you back';
      });
    });
  }

  function init() {
    var hosts = document.querySelectorAll('[data-nbd-quick-form]');
    for (var i = 0; i < hosts.length; i++) render(hosts[i]);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
