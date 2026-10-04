// landing-page.js — the /pro product page. CSP-safe: no inline handlers.
// Budget: 5 KB (tests/pro-landing-budget-2026-10-04.test.js).
(function () {
  'use strict';

  // THE demo link. Every "Book a demo" button ([data-demo-link]) gets this
  // href; nothing else on the page names the URL. Their static href is Jo's
  // main Cal.com page, so a visitor without JS still reaches a booking page.
  var DEMO_URL = 'https://cal.com/nobigdeal/nbd-pro-demo';

  document.querySelectorAll('[data-demo-link]').forEach(function (a) {
    a.setAttribute('href', DEMO_URL);
  });

  // FAQ accordion. Questions are real <button>s; aria-expanded tracks state.
  function toggleFAQ(q) {
    var a = q.nextElementSibling;
    var open = q.getAttribute('aria-expanded') !== 'true';
    document.querySelectorAll('.pl-faq-q[aria-expanded="true"]').forEach(function (o) {
      if (o !== q) { o.setAttribute('aria-expanded', 'false'); o.nextElementSibling.classList.remove('is-open'); }
    });
    q.setAttribute('aria-expanded', String(open));
    a.classList.toggle('is-open', open);
  }

  // data-pl-action delegate. goRegister keeps the data-plan wiring
  // register.html reads (?plan=starter|team|growth).
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-pl-action]');
    if (!t) return;
    var action = t.getAttribute('data-pl-action');
    if (action === 'goRegister') {
      e.preventDefault();
      var plan = t.getAttribute('data-plan');
      window.location.href = '/pro/register.html' + (plan ? '?plan=' + plan : '');
    } else if (action === 'toggleFAQ') {
      toggleFAQ(t);
    }
  });
})();
