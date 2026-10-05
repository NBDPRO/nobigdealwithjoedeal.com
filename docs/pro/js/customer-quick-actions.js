/* customer-quick-actions.js — keep the customer header's action bar from
 * eating the phone.
 *
 * The bar carries 13 always-on plus 4 conditional controls. At <=900px
 * customer.html lays them out as a 2-column grid with `min-height:48px`
 * buttons, so at scroll 0 it measured 334px — 388px once #stageProgressBtn
 * unhides — on a 390px-wide screen. The rep opened a customer and saw a wall
 * of buttons instead of the customer.
 *
 * It also carried `position:sticky; top:0` with a comment claiming the
 * "always visible" spec was met. It never was: the bar is the LAST CHILD of
 * .customer-header, and a sticky element is clipped to its containing block,
 * so it travelled the header's ~24px of bottom padding and then scrolled
 * away like everything else. That rule is gone; .jump-nav directly below is
 * the element that actually pins, and it works because it is a sibling of
 * the header rather than inside it.
 *
 * What this module does, on phones only: everything outside a small primary
 * set collapses behind a "More" disclosure. Desktop is untouched.
 *
 * Implementation notes
 *   - Membership is an explicit ID/action allowlist, never a positional
 *     nth-child rule. Four of the controls are conditional and unhide later
 *     (from seven different modules), so position does not track what the
 *     rep can actually see.
 *   - Hiding is done by adding a CLASS and letting the stylesheet decide.
 *     The module never writes element.style.display, so it can't fight the
 *     inline display:none that gates the conditional buttons, and can't
 *     resurrect a control its owner meant to keep hidden.
 *   - A MutationObserver re-counts when those modules unhide their buttons.
 *   - CSP: no inline handlers. The toggle is a data-action, resolved by the
 *     delegate in customer-tasks-ui.js off window.
 */
(function () {
  'use strict';

  var BAR_SEL = '.quick-actions';
  var MOBILE_MAX = 900;

  /* Stays visible on a phone: reach the customer, and move the job forward.
   * Everything else — the four portal-link buttons, the share panel, PDF
   * export, edit, photo report, review SMS, referral code — is a deliberate
   * trip to the More list, not something a rep needs one thumb away. */
  // briefMeBtn (2026-10-04): "Brief me" is the pre-visit tool — one thumb away
  // standing in the driveway, not a trip to More.
  var PRIMARY_IDS = ['callLink', 'smsBookingLink', 'emailLink', 'stageProgressBtn', 'bookingKindSelect', 'briefMeBtn'];
  var PRIMARY_ACTIONS = ['progressStage'];

  function isPrimary(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.id && PRIMARY_IDS.indexOf(el.id) !== -1) return true;
    var a = el.getAttribute && el.getAttribute('data-action');
    return !!a && PRIMARY_ACTIONS.indexOf(a) !== -1;
  }

  /* Hidden by its own owner (markup or a module), so it should not be
   * counted as something the More button is concealing. */
  function ownerHidden(el) {
    return el.style && el.style.display === 'none';
  }

  function bar() { return document.querySelector(BAR_SEL); }

  function ensureToggle(b) {
    var t = document.getElementById('qaMoreBtn');
    if (t) return t;
    t = document.createElement('button');
    t.type = 'button';
    t.id = 'qaMoreBtn';
    t.className = 'btn';
    t.setAttribute('data-action', 'toggleQuickActions');
    t.setAttribute('aria-controls', 'quickActionsBar');
    b.appendChild(t);
    return t;
  }

  function apply() {
    var b = bar();
    if (!b) return;
    if (!b.id) b.id = 'quickActionsBar';

    // Tag membership once per element; new nodes get tagged on mutation.
    var kids = b.children, i, el;
    for (i = 0; i < kids.length; i++) {
      el = kids[i];
      if (el.id === 'qaMoreBtn') continue;
      if (isPrimary(el)) el.classList.remove('qa-more');
      else el.classList.add('qa-more');
    }

    var mobile = window.matchMedia('(max-width:' + MOBILE_MAX + 'px)').matches;
    var t = document.getElementById('qaMoreBtn');

    if (!mobile) {
      b.removeAttribute('data-qa-collapsed');
      if (t) t.hidden = true;
      return;
    }

    var hidden = 0;
    for (i = 0; i < kids.length; i++) {
      el = kids[i];
      if (el.id === 'qaMoreBtn') continue;
      if (el.classList.contains('qa-more') && !ownerHidden(el)) hidden++;
    }

    if (!hidden) { if (t) t.hidden = true; return; }

    t = ensureToggle(b);
    t.hidden = false;
    // Default to collapsed the first time; respect the rep's choice after.
    if (!b.hasAttribute('data-qa-collapsed') && !b.hasAttribute('data-qa-touched')) {
      b.setAttribute('data-qa-collapsed', '1');
    }
    var collapsed = b.getAttribute('data-qa-collapsed') === '1';
    t.textContent = collapsed ? ('More (' + hidden + ')') : 'Fewer';
    t.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }

  window.toggleQuickActions = function () {
    var b = bar();
    if (!b) return;
    b.setAttribute('data-qa-touched', '1');
    b.setAttribute('data-qa-collapsed', b.getAttribute('data-qa-collapsed') === '1' ? '0' : '1');
    apply();
  };

  function boot() {
    var b = bar();
    if (!b) return;
    apply();
    try {
      // Seven modules unhide conditional controls after first paint; re-count
      // when they do, or the More badge lies about what is behind it.
      new MutationObserver(function () { apply(); }).observe(b, {
        childList: true, subtree: false, attributes: true, attributeFilter: ['style', 'hidden']
      });
    } catch (e) { /* observer is an optimisation, not a requirement */ }
    var t;
    window.addEventListener('resize', function () {
      clearTimeout(t);
      t = setTimeout(apply, 150);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
