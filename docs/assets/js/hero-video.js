/* hero-video.js — starts the muted background loop in a page's hero.
 *
 * One component for every hero that has one (markup: site-src/partials/
 * hero-video-*.html, mapping: site-src/data/hero-video.json). The <video>
 * ships with no src and preload="none", so nothing is fetched until this runs:
 *   - never on prefers-reduced-motion, Save-Data, or a 2g / slow-2g connection
 *     (the poster, or the homepage photo, is the whole hero then);
 *   - only after the page's load event plus an idle slot (1.5 s cap), so the
 *     video can never compete with the LCP image or text;
 *   - only once the hero is on screen; paused again when it scrolls away or
 *     the tab is hidden.
 * Source: AV1 WebM when the browser says it can play it, else H.264 MP4;
 * the 720x1280 cut on portrait phones up to 600px wide; 1080p only for big
 * dense screens on a fast connection where the clip has it; 720p otherwise.
 * Always muted, never controls, never sound. A rejected play() just leaves
 * the poster showing.
 * Bump ASSET_VERSION in scripts/hero-video.mjs when this file changes. */
(function () {
  'use strict';
  var vids = Array.prototype.slice.call(document.querySelectorAll('video[data-hero-video]'));
  if (!vids.length || !window.matchMedia || !('IntersectionObserver' in window)) return;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduce.matches) return;
  var conn = navigator.connection || {};
  var type = String(conn.effectiveType || '');
  if (conn.saveData || /(^|-)2g$/.test(type)) return;

  function pickSrc(v) {
    var ext = v.canPlayType('video/webm; codecs="av01.0.08M.08"') === 'probably' ? 'av1' : 'mp4';
    var key = '';
    if (window.matchMedia('(max-width: 600px) and (orientation: portrait)').matches) key = '-portrait';
    else if (type !== '3g' && window.innerWidth * (window.devicePixelRatio || 1) >= 1800 &&
             v.hasAttribute('data-src-' + ext + '-1080')) key = '-1080';
    return v.getAttribute('data-src-' + ext + key) || v.getAttribute('data-src-mp4');
  }

  function wire(v) {
    var visible = false;
    var loaded = false;
    v.muted = true;
    v.defaultMuted = true;
    v.addEventListener('playing', function () { v.classList.add('is-playing'); });
    v.addEventListener('error', function () { v.classList.remove('is-playing'); });

    function play() {
      if (!visible || document.hidden || reduce.matches) return;
      if (!loaded) {
        var src = pickSrc(v);
        if (!src) return;
        v.src = src;
        loaded = true;
      }
      var p = v.play();
      if (p && typeof p.catch === 'function') p.catch(function () { /* autoplay refused: poster stays */ });
    }

    new IntersectionObserver(function (entries) {
      visible = entries[entries.length - 1].isIntersecting;
      if (visible) play(); else v.pause();
    }).observe(v);

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) v.pause(); else play();
    });

    var onMotionPref = function () {
      if (reduce.matches) { v.pause(); v.classList.remove('is-playing'); } else play();
    };
    if (reduce.addEventListener) reduce.addEventListener('change', onMotionPref);
    else if (reduce.addListener) reduce.addListener(onMotionPref);
  }

  function boot() { vids.forEach(wire); }
  function whenIdle() {
    if ('requestIdleCallback' in window) window.requestIdleCallback(boot, { timeout: 1500 });
    else setTimeout(boot, 1500);
  }
  if (document.readyState === 'complete') whenIdle();
  else window.addEventListener('load', whenIdle);
})();
