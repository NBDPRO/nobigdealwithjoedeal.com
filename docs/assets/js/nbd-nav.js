/* nbd-nav.js — the single owner of the header, the mobile drawer and the
   Services dropdown. Replaces assets/js/inline/479bd49556.js (the sitewide
   toggler) and assets/js/blog-nav.js (the /pro/blog delegate).

   WHY ONE OWNER (2026-09-08 nav reliability audit)
   ------------------------------------------------
   Two togglers existed. They never landed on the same page, but nothing
   stopped them from doing so, and if they had, the hamburger would have
   silently died: 479bd49556 set open=true on the direct listener, blog-nav's
   document-level delegate then toggled it straight back to false in the same
   dispatch. A dead hamburger with no error in the console is the worst
   failure mode this file can have, so takeover here is explicit rather than
   cooperative — see takeOver() below.

   BROWSER FLOOR: iOS 12 / Safari 12 (oldest iPod touch still in the wild).
   ES6 (let/const/arrow/template literals) is fine there. Deliberately NOT
   used: optional chaining `?.` and nullish coalescing `??` (Safari 13.4+),
   logical assignment, Array.prototype.at, String.replaceAll, structuredClone.
   A syntax error here is not a degraded menu — it is no menu at all.
*/
(function () {
  'use strict';

  // Idempotence. A second copy of this file (a stray tag, a partial stamped
  // twice) must be inert rather than double-binding every listener.
  if (window.__nbdNavReady) return;
  window.__nbdNavReady = true;

  var OPEN_CLASS = 'open';
  var BODY_CLASS = 'nbd-nav-open';
  var MOBILE_MAX = 1024; // matches the CSS breakpoint that hides .nav-links

  var savedScrollY = 0;
  // True while a drawer LINK is closing the drawer: that link may be scrolling
  // to a section on purpose, so the restore must not fight it (see unlockScroll).
  var closingViaLink = false;

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  /* ── window.scrollTo(options) shim ──────────────────────────────────────
     13 call sites across 8 shipped files pass a ScrollToOptions dictionary
     (`window.scrollTo({top: 0, behavior: 'smooth'})`). Safari below 14 only
     implements the two-argument form, so the object coerces to
     scrollTo(NaN, undefined) and the page does not move — every "back to
     top", every wizard step change, every smooth-scroll to an anchor, silently
     dead on the iPod touch.

     Patching here rather than at 13 call sites because this file already ships
     on all 232 pages and, verified page by page, on every page that owns one
     of those calls. It runs first (deferred, inside <nav>) and the call sites
     fire from event handlers later, so ordering is not a concern.

     Gated on the feature test, so on any browser that understands smooth
     scrolling the native implementation is left completely alone. */
  if (!('scrollBehavior' in document.documentElement.style) && window.scrollTo) {
    var nativeScrollTo = window.scrollTo;
    window.scrollTo = function (a, b) {
      if (a && typeof a === 'object') {
        return nativeScrollTo.call(window, a.left || 0, a.top || 0);
      }
      return nativeScrollTo.call(window, a, b);
    };
  }

  /* ── Header height ──────────────────────────────────────────────────────
     The drawer reserves room for the header with padding-top. The header's
     real bottom edge moves: the announcement bar sits in flow above a
     position:sticky nav, so at scroll top the nav bottom is ~110-129px and
     once scrolled it is ~70px. Publishing the measured value beats any
     constant, and the CSS fallback covers the case where this never runs. */
  function syncHeaderHeight() {
    var nav = document.getElementById('mainNav') || $('nav.nav') || $('nav');
    if (!nav) return;
    var bottom = nav.getBoundingClientRect().bottom;
    // Clamp: a collapsed or absurd measurement must not push every link off
    // screen, and must not tuck the first link under the header.
    if (!isFinite(bottom) || bottom < 40) bottom = 70;
    if (bottom > 240) bottom = 240;
    document.documentElement.style.setProperty('--nbd-header-h', Math.round(bottom) + 'px');
  }

  /* ── Body scroll lock ───────────────────────────────────────────────────
     iOS Safari ignores overflow:hidden on <body>. Pinning the body with
     position:fixed and a negative top is the only lock it honours; the offset
     has to be restored by hand on release or the page jumps to the top, which
     is its own kind of "unnavigable". */
  function lockScroll() {
    savedScrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
    document.body.style.top = '-' + savedScrollY + 'px';
    document.body.classList.add(BODY_CLASS);
  }

  // Jump with NO animation. The inline scroll-behavior:auto swap below is not
  // always honoured: CI's Linux WebKit (2026-10-01) caught the restore
  // mid-glide at 55 and 468 on the way back to 1200. An explicit
  // behavior:'instant' overrides any CSS scroll-behavior; browsers without
  // scrollTo(options) take the plain two-number form.
  function jumpTo(y) {
    try { window.scrollTo({ top: y, left: 0, behavior: 'instant' }); }
    catch (e) { window.scrollTo(0, y); }
    if (Math.abs((window.pageYOffset || 0) - y) > 2) window.scrollTo(0, y);
  }

  function unlockScroll() {
    if (!document.body.classList.contains(BODY_CLASS)) return;
    document.body.classList.remove(BODY_CLASS);
    document.body.style.top = '';

    /* `html{scroll-behavior:smooth}` is set sitewide, which turns this restore
       into an ANIMATION: the reader watches the page glide back to where they
       were over ~half a second, and anything that interrupts the animation
       leaves them somewhere else entirely. CI caught it mid-glide, reading 410
       and 68 where the saved offset was ~1200. Force the restore to be
       instant, then hand smooth scrolling back to the page's own anchors. */
    var root = document.documentElement;
    var prevBehavior = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    // While pinned, the page is one viewport tall. If WebKit has not laid out
    // the un-pinned body yet, the restore is clamped to 0 and the reader lands
    // at the top (CI mobile-webkit, first attempts: 1200 → 0). Force the
    // un-pinned layout first.
    void document.body.offsetHeight;
    jumpTo(savedScrollY);
    // Commit the jump before smooth scrolling is restored, or the browser can
    // coalesce the two style changes and animate anyway.
    void root.offsetHeight;
    root.style.scrollBehavior = prevBehavior;
    // Belt and braces: re-check as layout settles and re-apply if the restore
    // did not stick.
    //  - Closed by the hamburger, Escape or a tap outside (nothing navigates):
    //    the reader must land EXACTLY where they were, so any drift is
    //    corrected. CI's mobile WebKit (2026-10-02) still landed 55-72 px off
    //    on some runs — the old near-0-only check let those through, about 1
    //    Public-surface run in 10.
    //  - Closed by a drawer link: that link may be smooth-scrolling to a
    //    section, so only the clamped-to-the-top failure is corrected.
    var target = savedScrollY;
    var exact = !closingViaLink;
    closingViaLink = false;
    if (target > 2) {
      // CI's Linux WebKit (2026-10-01) still landed at 0 on every retry of
      // some runs: the un-pinned page can lay out after the next frame, so one
      // re-apply is not enough. Re-check on the next frame and twice more as
      // layout settles. Still only when clamped near 0, and never after the
      // reader starts scrolling themselves.
      var userMoved = false;
      var markMoved = function () { userMoved = true; };
      window.addEventListener('touchstart', markMoved, { passive: true, once: true });
      window.addEventListener('wheel', markMoved, { passive: true, once: true });
      var reapply = function () {
        var at = window.pageYOffset || 0;
        if (userMoved) return;
        if (exact ? Math.abs(at - target) <= 2 : at > 2) return;
        var pb = root.style.scrollBehavior;
        root.style.scrollBehavior = 'auto';
        jumpTo(target);
        void root.offsetHeight;
        root.style.scrollBehavior = pb;
      };
      if (window.requestAnimationFrame) window.requestAnimationFrame(reapply);
      setTimeout(reapply, 60);
      setTimeout(function () {
        reapply();
        window.removeEventListener('touchstart', markMoved);
        window.removeEventListener('wheel', markMoved);
      }, 250);
    }
  }

  /* ── Drawer ─────────────────────────────────────────────────────────── */
  var hb = null;
  var mn = null;

  function isOpen() {
    return !!mn && mn.classList.contains(OPEN_CLASS);
  }

  function setOpen(open) {
    if (!hb || !mn) return;
    open = !!open;

    // No early return on the close path. docs/index.html and
    // docs/sites/free-guide/ ship their own closeMobileNav(), called from a
    // smooth-scroll handler bound to the <a> itself. A target-phase listener
    // on the link runs BEFORE this bubble-phase listener on the drawer, so by
    // the time we get here `.open` is already gone — and a transition guard
    // would skip unlockScroll() and leave the body pinned with position:fixed
    // forever. Closing must always release the lock, transition or not.
    if (open && isOpen()) return;

    mn.classList.toggle(OPEN_CLASS, open);
    hb.setAttribute('aria-expanded', open ? 'true' : 'false');
    hb.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    // The drawer is a modal sheet; hide the page from assistive tech while it
    // is up so a screen reader cannot wander behind it.
    mn.setAttribute('aria-hidden', open ? 'false' : 'true');

    // Bar animation. querySelectorAll returns a static NodeList; index it
    // rather than calling .forEach so a missing third <span> cannot throw
    // partway through and leave the button visually stuck as an X.
    var bars = hb.querySelectorAll('span');
    if (bars.length >= 3) {
      bars[0].style.cssText = open ? 'transform:rotate(45deg) translate(5px,5px)' : '';
      bars[1].style.cssText = open ? 'opacity:0' : '';
      bars[2].style.cssText = open ? 'transform:rotate(-45deg) translate(5px,-5px)' : '';
    }

    if (open) {
      syncHeaderHeight();
      lockScroll();
      mn.scrollTop = 0;
    } else {
      unlockScroll();
    }
  }

  function closeDrawer(returnFocus) {
    if (!isOpen()) return;
    setOpen(false);
    if (returnFocus && hb) hb.focus();
  }

  /* ── Takeover ───────────────────────────────────────────────────────────
     Replacing the button with a clone drops every listener a previously
     loaded toggler bound to it, so this file is the only thing that can
     respond to a tap. Cheap, and it makes the double-toggle failure
     unreachable instead of merely unlikely. */
  function takeOver(btn) {
    var clone = btn.cloneNode(true);
    if (btn.parentNode) btn.parentNode.replaceChild(clone, btn);
    return clone;
  }

  function initDrawer() {
    var btn = document.getElementById('hamburger') || $('.hamburger');
    mn = document.getElementById('mobileNav') || $('.mobile-nav');
    if (!btn || !mn) return;

    hb = takeOver(btn);

    // A <button> outside a form defaults to type="submit" in some engines; if
    // the nav ever ends up inside a form that submits the page on every tap.
    if (!hb.getAttribute('type')) hb.setAttribute('type', 'button');
    if (!hb.getAttribute('aria-controls')) hb.setAttribute('aria-controls', 'mobileNav');
    hb.setAttribute('aria-expanded', 'false');
    mn.setAttribute('aria-hidden', 'true');
    if (!mn.getAttribute('role')) mn.setAttribute('role', 'dialog');
    if (!mn.getAttribute('aria-modal')) mn.setAttribute('aria-modal', 'true');
    if (!mn.getAttribute('aria-label')) mn.setAttribute('aria-label', 'Site menu');

    hb.addEventListener('click', function (e) {
      e.preventDefault();
      // Stops any surviving document-level delegate (blog-nav.js) from seeing
      // this click and toggling the drawer a second time.
      e.stopPropagation();
      setOpen(!isOpen());
    });

    // Following a link closes the drawer. Without this the scroll lock stays
    // on across a same-document hash navigation and the page is frozen.
    mn.addEventListener('click', function (e) {
      var t = e.target;
      if (t && t.closest && t.closest('a')) { closingViaLink = true; setOpen(false); }
    });

    // Tap outside the drawer closes it.
    document.addEventListener('click', function (e) {
      if (!isOpen()) return;
      var t = e.target;
      if (!t) return;
      if (mn.contains(t)) return;
      if (hb.contains(t)) return;
      closeDrawer(false);
    });

    document.addEventListener('keydown', function (e) {
      if (!isOpen()) return;
      if (e.key === 'Escape' || e.key === 'Esc') {
        closeDrawer(true);
        return;
      }
      if (e.key === 'Tab') trapFocus(e);
    });

    // Rotating to landscape or growing past the breakpoint hides the
    // hamburger in CSS. Leaving the drawer open there strands the user behind
    // a locked body with no visible control to close it.
    window.addEventListener('resize', function () {
      syncHeaderHeight();
      if (isOpen() && window.innerWidth > MOBILE_MAX) closeDrawer(false);
    });
    window.addEventListener('orientationchange', function () {
      setTimeout(syncHeaderHeight, 200);
    });

    // The announcement bar rotates and the nav sticks, so the header's bottom
    // edge changes as the page scrolls.
    window.addEventListener('scroll', function () {
      if (!isOpen()) syncHeaderHeight();
    }, supportsPassive() ? { passive: true } : false);

    // Back/forward restores a cached page with the drawer still open and the
    // body still pinned. Reset to a known-good state on every show.
    window.addEventListener('pageshow', function () {
      if (isOpen()) {
        mn.classList.remove(OPEN_CLASS);
        hb.setAttribute('aria-expanded', 'false');
        hb.setAttribute('aria-label', 'Open menu');
        mn.setAttribute('aria-hidden', 'true');
        var bars = hb.querySelectorAll('span');
        for (var i = 0; i < bars.length; i++) bars[i].style.cssText = '';
      }
      unlockScroll();
      syncHeaderHeight();
    });

    window.addEventListener('hashchange', function () { closeDrawer(false); });
    window.addEventListener('popstate', function () { closeDrawer(false); });

    // Catch-all: if ANYTHING strips `.open` without going through setOpen —
    // a legacy closeMobileNav(), a future script, a devtools poke — release
    // the scroll lock anyway. A frozen page is the one failure mode a user
    // cannot recover from without a reload, so it gets a backstop that does
    // not depend on every caller being well behaved.
    if (window.MutationObserver) {
      new MutationObserver(function () {
        if (!isOpen() && document.body.classList.contains(BODY_CLASS)) unlockScroll();
      }).observe(mn, { attributes: true, attributeFilter: ['class'] });
    }
  }

  /* Keep Tab inside the open sheet — the page behind it is inert to the eye,
     so it should be inert to the keyboard too. */
  function trapFocus(e) {
    var items = mn.querySelectorAll('a[href], button:not([disabled])');
    if (!items.length) return;
    var first = items[0];
    var last = items[items.length - 1];
    var active = document.activeElement;
    if (e.shiftKey && (active === first || active === hb)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function supportsPassive() {
    var ok = false;
    try {
      window.addEventListener('nbd-probe', null, Object.defineProperty({}, 'passive', {
        get: function () { ok = true; return false; }
      }));
    } catch (err) { /* old engine: fall back to a boolean third argument */ }
    return ok;
  }

  /* ── Services dropdown ──────────────────────────────────────────────────
     The CSS has always supported a `.open` class, but nothing ever set it —
     the menu was hover-and-focus-within only. On a touch screen that is a
     coin flip: the first tap paints :hover, and whether the parent <a
     href="/#services"> also navigates is engine-dependent. An explicit tap
     toggle makes the behaviour the same everywhere. */
  function initDropdowns() {
    var dds = document.querySelectorAll('#navLinks .dropdown, .nav-links .dropdown');
    if (!dds.length) return;

    var coarse = false;
    try {
      coarse = window.matchMedia && window.matchMedia('(hover: none)').matches;
    } catch (err) { /* no matchMedia: treat as a mouse device, i.e. today's behaviour */ }

    for (var i = 0; i < dds.length; i++) {
      (function (dd) {
        var trigger = dd.querySelector('a');
        if (!trigger) return;

        trigger.setAttribute('aria-haspopup', 'true');
        trigger.setAttribute('aria-expanded', 'false');

        trigger.addEventListener('click', function (e) {
          // Never swallow a modifier click. nav-faq.js used to preventDefault
          // unconditionally, so Cmd/Ctrl-click on Services silently did
          // nothing instead of opening a new tab.
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return;

          var open = dd.classList.contains('open');

          // Second tap on an already-open menu follows the link, so
          // /#services stays reachable on touch. On a mouse the second click
          // just closes it again — hover already exposes the contents.
          if (open) {
            if (coarse) return;
            e.preventDefault();
            closeAllDropdowns();
            return;
          }

          e.preventDefault();
          closeAllDropdowns();
          dd.classList.add('open');
          trigger.setAttribute('aria-expanded', 'true');
        });

        // Keyboard users get the same explicit state as touch users.
        trigger.addEventListener('focus', function () {
          trigger.setAttribute('aria-expanded', 'true');
        });
      })(dds[i]);
    }

    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return closeAllDropdowns();
      if (!t.closest('.dropdown')) closeAllDropdowns();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || e.key === 'Esc') {
        var had = document.querySelector('.dropdown.open');
        closeAllDropdowns();
        // Returning focus to the trigger keeps the tab position sensible.
        if (had) {
          var a = had.querySelector('a');
          if (a) a.focus();
        }
      }
    });
  }

  function closeAllDropdowns() {
    var open = document.querySelectorAll('.dropdown.open');
    for (var i = 0; i < open.length; i++) {
      open[i].classList.remove('open');
      var a = open[i].querySelector('a');
      if (a) a.setAttribute('aria-expanded', 'false');
    }
  }

  function init() {
    syncHeaderHeight();
    initDrawer();
    initDropdowns();
  }

  // This script ships with `defer`, so the DOM is parsed by the time it runs.
  // The readyState check covers a stray non-deferred tag on a page we do not
  // control, where #mobileNav (a sibling AFTER </nav>) would not exist yet.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
