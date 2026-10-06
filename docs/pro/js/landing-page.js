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

  // The tour. Without JS every step is shown, stacked. With JS it becomes a
  // tab list: one step visible, arrow keys move between tabs (WAI-ARIA).
  var tour = document.querySelector('.pl-tour');
  var tabs = tour ? Array.prototype.slice.call(tour.querySelectorAll('[role="tab"]')) : [];
  function selectTab(t, focus) {
    tabs.forEach(function (x) {
      var on = x === t;
      x.setAttribute('aria-selected', String(on));
      x.tabIndex = on ? 0 : -1;
      var p = document.getElementById(x.getAttribute('aria-controls'));
      if (p) p.hidden = !on;
    });
    if (focus) t.focus();
    if (t.scrollIntoView && t.parentNode.scrollWidth > t.parentNode.clientWidth) {
      t.parentNode.scrollLeft = t.offsetLeft - 16;
    }
  }
  if (tabs.length) {
    tour.classList.add('js-tour');
    selectTab(tabs[0], false);
    tour.addEventListener('keydown', function (e) {
      var i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      var n = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? i + 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? i - 1
          : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
      if (n === null) return;
      e.preventDefault();
      selectTab(tabs[(n + tabs.length) % tabs.length], true);
    });
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
    } else if (action === 'tourTab') {
      selectTab(t, false);
    }
  });

  // Scroll reveal. Only when the visitor allows motion and the browser has
  // IntersectionObserver; otherwise nothing is ever hidden.
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (still || !('IntersectionObserver' in window)) return;
  var targets = document.querySelectorAll('.pl-sec .pl-head, .pl-sec .pl-copy, .pl-chain-wrap, .pl-field-item, .pl-wide, .pl-facts, .pl-doclist, .pl-ai-main, .pl-ai-bots, .pl-ledger, .pl-shop-list, .pl-plans, .pl-proof-row');
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); }
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  targets.forEach(function (el) {
    var r = el.getBoundingClientRect();
    if (r.top < window.innerHeight && r.bottom > 0) return; // already on screen: never hide it
    el.classList.add('pl-rv');
    io.observe(el);
  });
})();
