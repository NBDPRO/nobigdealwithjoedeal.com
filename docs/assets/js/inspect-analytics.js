/* inspect-analytics.js — GA4 drop-off events for /inspect (CRO review #10,
 * 2026-10-06). Until now the page sent only `generate_lead` on success, so
 * nobody could see who started the form, which check stopped them, or how
 * many tapped Call/Text instead.
 *
 *   inspect_form_start   first focus inside #inspectForm (once per page view)
 *   inspect_form_error   each time inspect-form.js shows #inspectFormError;
 *                        `fields` = the ids it marked aria-invalid (ids only)
 *   contact_tap          any tel:/sms: link; method 'tel'|'sms', place =
 *                        'hero' | 'form' | 'thanks' | 'sticky' | 'other'
 *
 * No PII: never reads an input's value, a phone number or the error text.
 * Read-only on the page: it only listens and observes, so the form works the
 * same with this file missing. GA4's gtag uses sendBeacon, so the tap event
 * survives the hand-off to the dialer.
 */
(function () {
  'use strict';

  function send(name, params) {
    try {
      if (typeof window.gtag === 'function') window.gtag('event', name, params || {});
    } catch (e) {}
  }

  function placeOf(el) {
    if (!el || !el.closest) return 'other';
    if (el.closest('.mobile-cta-strip')) return 'sticky';
    if (el.closest('#inspectSuccess')) return 'thanks';
    if (el.closest('#inspectForm, .form-panel')) return 'form';
    if (el.closest('.hero-left')) return 'hero';
    return 'other';
  }

  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href^="tel:"], a[href^="sms:"]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    send('contact_tap', { method: href.indexOf('sms:') === 0 ? 'sms' : 'tel', place: placeOf(a), page: 'inspect' });
  });

  function onReady() {
    var form = document.getElementById('inspectForm');
    if (!form) return;

    var started = false;
    form.addEventListener('focusin', function () {
      if (started) return;
      started = true;
      send('inspect_form_start', { page: 'inspect' });
    });

    if (typeof MutationObserver !== 'function') return;
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes || [];
        for (var j = 0; j < added.length; j++) {
          if (added[j] && added[j].id === 'inspectFormError') {
            var ids = [];
            form.querySelectorAll('[aria-invalid="true"]').forEach(function (el) { if (el.id) ids.push(el.id); });
            if (!ids.length) {
              var consent = document.getElementById('ins-consent');
              ids.push(consent && !consent.checked ? 'ins-consent' : 'submit');
            }
            send('inspect_form_error', { fields: ids.join(','), page: 'inspect' });
            return;
          }
        }
      }
    }).observe(form, { childList: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
  else onReady();
})();
