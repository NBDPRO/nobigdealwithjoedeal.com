/* Announcement bar: short/long text swap + slide rotation.
   Shared across all homeowner pages so the bar reads on a single line
   at ≤600px (was wrapping the phone number to a second row on Android
   phones because the long text "Free Roof Inspections — Call or Text
   Joe: (859) 420-7382" overflows narrow viewports). */
(function(){
  var mq = window.matchMedia('(max-width:600px)');
  function sync(){
    var nodes = document.querySelectorAll('.ann-text');
    for (var i = 0; i < nodes.length; i++){
      var el = nodes[i];
      var want = mq.matches ? (el.dataset.short || el.dataset.long) : el.dataset.long;
      if (want && el.textContent !== want) el.textContent = want;
    }
  }
  sync();
  if (mq.addEventListener) mq.addEventListener('change', sync);
  else if (mq.addListener) mq.addListener(sync);
})();

/* Slide rotation (a11y pass, 2026-11-27, documentation/audit/A11Y-LEAD-PAGES-2026-11-27.md).
   The one rotation on a page: inline/b1d1695580.js used to run a second timer
   beside this one on ~167 pages, ignoring reduced motion. WCAG 2.2.2 asks for a
   way to pause anything that moves for more than 5 s, so the bar:
   - never rotates under prefers-reduced-motion, or at phone width, where
     nbd-nav.css hides the bar or pins the seasonal slide alone;
   - holds still while the pointer is over it or focus is inside it;
   - starts with a "Pause announcements" button, out of sight until a keyboard
     focuses it (screen readers find it too);
   - hides the slides that are not showing (aria-hidden + inert), so neither Tab
     nor a screen reader lands on an invisible link. */
(function(){
  if (window.__nbdAnnRotation) return;
  window.__nbdAnnRotation = true;
  var bar = document.querySelector('.ann-bar');
  var slides = bar ? bar.querySelectorAll('.ann-slide') : [];
  if (slides.length < 2 || !window.matchMedia) return;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var phone = window.matchMedia('(max-width:768px)');
  var current = 0, timer = null, hovered = false, focused = false, paused = false;
  // The showing slide is whichever has .active, whoever set it, so a slide on
  // screen is never the one marked hidden.
  function activeIndex(){
    for (var i = 0; i < slides.length; i++) if (slides[i].classList.contains('active')) return i;
    return current;
  }
  function hideInactive(){
    current = activeIndex();
    for (var i = 0; i < slides.length; i++){
      var off = !phone.matches && i !== current;
      if (off) { if (slides[i].getAttribute('aria-hidden') !== 'true') slides[i].setAttribute('aria-hidden', 'true'); slides[i].inert = true; }
      else { if (slides[i].hasAttribute('aria-hidden')) slides[i].removeAttribute('aria-hidden'); slides[i].inert = false; }
    }
  }
  if (window.MutationObserver) {
    new MutationObserver(hideInactive).observe(bar, { subtree: true, attributes: true, attributeFilter: ['class'] });
  }
  function step(){
    current = activeIndex();
    slides[current].classList.remove('active');
    slides[current].classList.add('exit');
    var prev = current;
    current = (current + 1) % slides.length;
    slides[current].classList.add('active');
    slides[current].classList.remove('exit');
    setTimeout(function(){ slides[prev].classList.remove('exit'); }, 600);
    hideInactive();
  }
  var btn = document.createElement('button');
  function sync(){
    var still = reduce.matches || phone.matches;
    var run = !still && !hovered && !focused && !paused;
    if (run && !timer) timer = setInterval(step, 4000);
    if (!run && timer) { clearInterval(timer); timer = null; }
    btn.hidden = still; // nothing rotates there, so no extra Tab stop
    hideInactive();
  }

  var HIDDEN = 'position:absolute;left:0;top:0;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;z-index:2';
  var SHOWN = 'position:absolute;left:8px;top:50%;transform:translateY(-50%);z-index:2;min-height:28px;padding:4px 12px;border:0;border-radius:100px;background:#fff;color:#12223d;font:inherit;font-size:.72rem;font-weight:800;letter-spacing:.04em;text-transform:uppercase;cursor:pointer;outline:3px solid #12223d;outline-offset:2px;box-shadow:0 0 0 2px #fff';
  btn.type = 'button';
  btn.className = 'ann-pause';
  btn.style.cssText = HIDDEN;
  function label(){
    btn.textContent = paused ? 'Play announcements' : 'Pause announcements';
    btn.setAttribute('aria-pressed', paused ? 'true' : 'false');
  }
  label();
  btn.addEventListener('focus', function(){ btn.style.cssText = SHOWN; });
  btn.addEventListener('blur', function(){ btn.style.cssText = HIDDEN; });
  btn.addEventListener('click', function(e){ e.stopPropagation(); paused = !paused; label(); sync(); });
  bar.insertBefore(btn, bar.firstChild);

  bar.addEventListener('mouseenter', function(){ hovered = true; sync(); });
  bar.addEventListener('mouseleave', function(){ hovered = false; sync(); });
  bar.addEventListener('focusin', function(){ focused = true; sync(); });
  bar.addEventListener('focusout', function(e){ focused = !!(e.relatedTarget && bar.contains(e.relatedTarget)); sync(); });
  [reduce, phone].forEach(function(mq){
    if (mq.addEventListener) mq.addEventListener('change', sync);
    else if (mq.addListener) mq.addListener(sync);
  });
  sync();
})();
