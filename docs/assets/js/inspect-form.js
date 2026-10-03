/**
 * inspect-form.js — /inspect lead-capture form handler.
 *
 * Behavior:
 *  - On load, read utm_source / utm_medium / utm_campaign from the URL
 *    and stamp them into the matching hidden form fields. This is the
 *    print-tracking pipeline: QR codes encode the UTM params and they
 *    flow into the submission so we know which piece (yard sign vs.
 *    door hanger vs. card-front) drove the lead.
 *  - On submit, prevent default, gather all fields, POST via
 *    window.submitPublicLead('inspect', payload), and swap the form for
 *    a success message. On error, re-enable the button and show an
 *    inline alert so the user can retry or call Joe directly.
 *  - Photos (2026-09-30) are UPLOADED, not just named: intake-extras.js
 *    reads them, the gateway answers with a one-time photoToken, and
 *    NBDIntake.afterSubmit sends each one (functions/public-lead-photos.js).
 *    The same block adds the REQUIRED scheduling choice, best time,
 *    insurance and how-heard.
 *  - Name, address and a 10-digit US mobile number are checked BEFORE the
 *    request (2026-09-13). The form is `novalidate` and this file used to post
 *    blind, so a missing phone reached the gateway, which answers a bare 400
 *    "Invalid submission" and keeps nothing — the homeowner saw that string
 *    with no hint which field was wrong, and the lead was gone. The phone rule
 *    is the one every public form now shares (tests/lead-form-phone-contract):
 *    digits only, a leading country-code 1 dropped, exactly 10 left.
 */
(function () {
  'use strict';

  function readUtms() {
    var params;
    try { params = new URLSearchParams(window.location.search); }
    catch (e) { return {}; }
    return {
      utm_source:   (params.get('utm_source')   || '').slice(0, 80),
      utm_medium:   (params.get('utm_medium')   || '').slice(0, 80),
      utm_campaign: (params.get('utm_campaign') || '').slice(0, 80)
    };
  }

  function stampHiddenFields(utms) {
    Object.keys(utms).forEach(function (k) {
      var el = document.getElementById(k);
      if (el) el.value = utms[k];
    });
  }

  function gatherFormData(form) {
    var fd = new FormData(form);
    var out = {};
    fd.forEach(function (v, k) {
      // The intake block's own inputs (scheduling radios) are read by
      // NBDIntake.read, not posted by name.
      if (k === 'photos' || /^ins[A-Z]/.test(k)) return;
      out[k] = typeof v === 'string' ? v.trim() : v;
    });
    out.source = '/inspect';
    return out;
  }

  // Shared public-form phone rule — keep byte-identical across the forms that
  // carry it (tests/lead-form-phone-contract.test.js pins the expression).
  function isUsPhone(v) {
    return String(v == null ? '' : v).replace(/\D/g, '').replace(/^1/, '').length === 10;
  }

  // Returns [] when the form can be sent, else the invalid inputs in order.
  function invalidFields() {
    var checks = [
      ['f-name', function (v) { return v.trim().length > 0; }],
      // A number and a street, not just a town or ZIP (2026-09-30).
      ['f-address', function (v) { v = v.trim(); return v.length >= 6 && /\d/.test(v) && /[a-z]/i.test(v); }],
      ['f-phone', isUsPhone]
    ];
    var bad = [];
    checks.forEach(function (c) {
      var el = document.getElementById(c[0]);
      if (!el) return;
      var good = c[1](el.value || '');
      el.setAttribute('aria-invalid', good ? 'false' : 'true');
      if (!good) bad.push(el);
    });
    return bad;
  }

  function invalidMessage(bad) {
    var ids = bad.map(function (el) { return el.id; });
    if (ids.length === 1 && ids[0] === 'f-phone') {
      return 'Please add a 10-digit mobile number (area code included) so Joe can reach you.';
    }
    return 'Please add your name, the property address and a 10-digit mobile number so Joe can reach you.';
  }

  // Hides the form, shows the confirmation, then (intake-extras.js) the
  // calendar button and the photo upload for this submission.
  function showSuccess(intake, res, data) {
    var form = document.getElementById('inspectForm');
    var ok = document.getElementById('inspectSuccess');
    if (form) form.style.display = 'none';
    if (ok && window.NBDIntake) {
      window.NBDIntake.afterSubmit(ok, {
        prefix: 'ins', quietContact: true, fields: intake.fields, files: intake.files, photoToken: (res && res.photoToken) || null,
        name: data.name, email: data.email, phone: data.phone, address: data.address
      });
    }
    if (ok) {
      ok.classList.add('visible');
      try { ok.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
    }
  }

  function showError(btn, msg) {
    if (btn) { btn.disabled = false; btn.textContent = 'Request Free Inspection'; }
    var form = document.getElementById('inspectForm');
    if (!form) return;
    var existing = document.getElementById('inspectFormError');
    if (existing) existing.remove();
    var p = document.createElement('p');
    p.id = 'inspectFormError';
    p.setAttribute('role', 'alert');
    p.style.cssText = 'margin-top:12px;padding:12px 14px;background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.35);border-radius:8px;color:#7f1d1d;font-size:.9rem;line-height:1.4';
    p.textContent = msg || 'Something went wrong. Please call or text Joe at (859) 420-7382.';
    form.appendChild(p);
  }

  function onReady() {
    var utms = readUtms();
    stampHiddenFields(utms);

    var form = document.getElementById('inspectForm');
    if (!form) return;

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var btn = document.getElementById('inspectSubmit');

      var bad = invalidFields();
      if (bad.length) {
        showError(btn, invalidMessage(bad));
        try { bad[0].focus(); } catch (e) {}
        return;
      }
      // TCPA (2026-10-03): the same express-written-consent box as
      // /storm-check, required because Joe calls and texts back. Unnamed, so
      // gatherFormData never picks it up; posted explicitly below.
      var consentEl = document.getElementById('ins-consent');
      var consent = !!(consentEl && consentEl.checked);
      if (!consent) {
        showError(btn, 'Please check the consent box so Joe can reach you.');
        try { consentEl.focus(); } catch (e) {}
        return;
      }
      // Scheduling choice (required) + photos and the rest.
      var intake = { fields: {}, files: [] };
      if (window.NBDIntake) {
        intake = window.NBDIntake.read(form, 'ins');
        if (intake.error) {
          if (intake.el && intake.el.classList) intake.el.classList.add('nbd-intake-invalid');
          showError(btn, intake.error);
          return;
        }
      }
      var prior = document.getElementById('inspectFormError');
      if (prior) prior.remove();

      if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }

      var data = gatherFormData(form);
      Object.keys(intake.fields).forEach(function (k) { data[k] = intake.fields[k]; });
      data.tcpaConsent = consent === true;

      if (typeof window.submitPublicLead !== 'function') {
        // public-lead-submit.js failed to load — fail loud so we can
        // tell from logs, but still surface a user-actionable message.
        console.error('[inspect-form] window.submitPublicLead unavailable');
        showError(btn);
        return;
      }

      window.submitPublicLead('inspect', data).then(function (res) {
        if (res && res.ok) {
          showSuccess(intake, res, data);
        } else {
          // The gateway client returns the server's message as `res.reason`
          // (not `res.error`), so the real rejection text was never surfaced —
          // read reason first, fall back to error for safety.
          var msg = (res && (res.reason || res.error)) ? String(res.reason || res.error) : '';
          console.warn('[inspect-form] submission rejected', res);
          // The gateway's per-field 400 is deliberately opaque; say what to check.
          if (/^invalid submission$/i.test(msg)) {
            msg = 'Something in the form did not go through. Check your name, address and 10-digit mobile number, or call or text Joe at (859) 420-7382.';
          }
          showError(btn, msg && /[a-z]/i.test(msg) ? msg : null);
        }
      }).catch(function (err) {
        console.error('[inspect-form] submission failed', err);
        showError(btn);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
})();
