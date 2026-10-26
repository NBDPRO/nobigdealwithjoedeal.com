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
  // the rest load it once. Until it answers, the trust line reads "Real Google
  // reviews": the rating ships empty and hidden, like the homepage (2026-10-15).
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
      s.src = '/assets/js/intake-extras.js?v=2';
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
        '<div class="qlf-msg qlf-err" id="' + uid + '-err" role="alert" tabindex="-1"></div>' +
        '<div class="qlf-msg qlf-ok" id="' + uid + '-ok" role="status" tabindex="-1"></div>' +
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
        // same wording; OPTIONAL (2026-10-15), and posted as tcpaConsent
        // (true or false) for the record.
        '<label class="sc-consent"><input type="checkbox" id="' + uid + '-consent"><span>I agree to receive text messages and calls from No Big Deal Home Solutions (No Big Deal Solutions LLC) at the number above about my request, including my results, appointment confirmations and reminders, estimate and project updates, and replies to my questions. Message frequency varies. Message &amp; data rates may apply. Reply STOP to opt out, HELP for help. Consent is not a condition of purchase. <a href="/privacy#sms-terms">Privacy Policy</a> &middot; <a href="/terms">Terms</a></span></label>' +
        // Trust line above Submit (2026-10-03). Rating hydrated live (hydrateRating).
        '<p class="qlf-trust"><span aria-hidden="true">&#9733;</span> <span data-nbd-gr-rating-wrap hidden><span data-nbd-gr-rating></span> on Google</span><span data-nbd-gr-rating-fallback>Real Google reviews</span> &middot; Fully insured &middot; Joe on every roof</p>' +
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

    // Show the visitor what happened, where they can see it (2026-10-26). The
    // status slots are the first children of an ~890px form and Send is the
    // last, so a message set in place sat above the viewport on a phone: an
    // empty submit looked like a dead button and "Got it" was never seen.
    function reveal(slot, field) {
      try { slot.scrollIntoView({ block: 'center' }); } catch (e) {}
      try { (field || slot).focus({ preventScroll: true }); } catch (e) {}
    }
    function list(parts) {
      return parts.length < 3 ? parts.join(' and ') : parts.slice(0, -1).join(', ') + ', and ' + parts[parts.length - 1];
    }
    // A marked field stops being marked as soon as it is edited.
    form.addEventListener('input', function (ev) {
      var t = ev.target;
      if (t && t.getAttribute && t.getAttribute('aria-invalid')) t.removeAttribute('aria-invalid');
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      err.textContent = ''; ok.textContent = '';
      var fnEl = document.getElementById(uid + '-fn');
      var phEl = document.getElementById(uid + '-ph');
      var adEl = document.getElementById(uid + '-ad');
      var firstName = fnEl.value.trim();
      var phone = phEl.value.trim();
      var address = adEl.value.trim();
      var email = document.getElementById(uid + '-em').value.trim();
      // Shared public-form phone rule: digits only, leading 1 dropped, exactly 10.
      var phoneOk = phone.replace(/\D/g, '').replace(/^1/, '').length === 10;
      var addressOk = address.length >= 6 && /\d/.test(address) && /[a-z]/i.test(address);
      var bad = [];
      [[fnEl, !!firstName, 'your first name'], [phEl, phoneOk, 'a 10-digit phone number'], [adEl, addressOk, 'your street address']].forEach(function (c) {
        if (c[1]) c[0].removeAttribute('aria-invalid');
        else { c[0].setAttribute('aria-invalid', 'true'); bad.push(c); }
      });
      if (bad.length) {
        err.textContent = 'Please add ' + list(bad.map(function (c) { return c[2]; })) + '.';
        reveal(err, bad[0][0]);
        return;
      }
      var consentEl = document.getElementById(uid + '-consent');
      // SMS consent is optional since 2026-10-15: the lead is saved either way; no automatic text without it.
      var consent = !!(consentEl && consentEl.checked);
      var intake = { fields: {}, files: [] };
      if (window.NBDIntake) {
        intake = window.NBDIntake.read(form, uid + 'i');
        if (intake.error) {
          if (intake.el && intake.el.classList) intake.el.classList.add('nbd-intake-invalid');
          err.textContent = intake.error;
          // The thing to fix is the choice, not the message: the form is tall,
          // so on a phone the message and the options are ~400px apart. Scroll
          // the fieldset (red border, legend) into view and focus its first
          // radio (the fieldset itself isn't focusable). The message is still
          // announced: err is the role=alert slot.
          if (intake.el && intake.el.scrollIntoView) {
            try { intake.el.scrollIntoView({ block: 'center' }); } catch (e) {}
            var firstRadio = intake.el.querySelector ? intake.el.querySelector('input') : null;
            try { (firstRadio || err).focus({ preventScroll: true }); } catch (e) {}
          } else {
            reveal(err);
          }
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
        if (!out || !out.ok) { var fail = new Error((out && out.reason) || 'failed'); fail.friendly = !!(out && out.friendly); throw fail; }
        ok.textContent = 'Got it! Joe will reach out shortly — usually same day.';
        btn.textContent = 'Sent ✓';
        reveal(ok);
        if (window.NBDIntake) {
          // Right under the message (not at the bottom of the form) so the
          // calendar button and photo status are on screen with it.
          var after = document.createElement('div');
          form.insertBefore(after, ok.nextSibling);
          window.NBDIntake.afterSubmit(after, {
            prefix: uid + 'i', fields: intake.fields, files: intake.files, photoToken: out.photoToken || null,
            firstName: firstName, phone: phone, email: email, address: address, service: service
          }).then(function () { form.reset(); });
        } else {
          form.reset();
        }
      }).catch(function (e2) {
        // The gateway's plain-language reason already says what to do; any
        // other failure gets the generic line. The raw text is console-only.
        console.warn('[quick-lead-form] send failed:', e2 && e2.message);
        err.textContent = e2 && e2.friendly ? e2.message : 'Could not send — please call or text (859) 420-7382.';
        btn.disabled = false; btn.textContent = 'Send — Joe calls you back';
        reveal(err);
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
