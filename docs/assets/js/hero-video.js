/* hero-video.js — starts the muted background loop in a page's hero.
 *
 * One component for every hero that has one (markup: site-src/partials/
 * hero-video-*.html, mapping: site-src/data/hero-video.json). The <video>
 * ships with no src and preload="none", so nothing is fetched until this runs:
 *   - never on prefers-reduced-motion, Save-Data, or a 3g / 2g / slow-2g connection
 *     (the poster, or the homepage photo, is the whole hero then);
 *   - only after the page's load event plus an idle slot (1.5 s cap), so the
 *     video can never compete with the LCP image or text;
 *   - only once the hero is on screen; paused again when it scrolls away or
 *     the tab is hidden.
 * Source: AV1 WebM when the browser says it can play it, else H.264 MP4;
 * the 720x1280 cut on portrait phones up to 600px wide; 1080p only for big
 * dense screens (1200+ CSS px wide, so never a phone or tablet held sideways)
 * where the clip has it; 720p otherwise.
 * Always muted, never controls, never sound. A rejected play() just leaves
 * the poster showing.
 * Pause (WCAG 2.2.2, 2026-11-27): the loop runs longer than 5 s next to the
 * page's words, so once it is playing a small Pause button sits in the hero's
 * top-right corner (hero-video.css shows it only while the loop is live). A
 * pause holds for the rest of the visit (sessionStorage), on every page.
 * Bump ASSET_VERSION in scripts/hero-video.mjs when this file changes. */
(function () {
  'use strict';
  var vids = Array.prototype.slice.call(document.querySelectorAll('video[data-hero-video]'));
  if (!vids.length || !window.matchMedia || !('IntersectionObserver' in window)) return;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduce.matches) return;
  var conn = navigator.connection || {};
  var type = String(conn.effectiveType || '');
  if (conn.saveData || /(^|-)[23]g$/.test(type)) return;

  function pickSrc(v) {
    var ext = v.canPlayType('video/webm; codecs="av01.0.08M.08"') === 'probably' ? 'av1' : 'mp4';
    var key = '';
    if (window.matchMedia('(max-width: 600px) and (orientation: portrait)').matches) key = '-portrait';
    else if (window.innerWidth >= 1200 && window.innerWidth * (window.devicePixelRatio || 1) >= 1800 &&
             v.hasAttribute('data-src-' + ext + '-1080')) key = '-1080';
    return v.getAttribute('data-src-' + ext + key) || v.getAttribute('data-src-mp4');
  }

  var PAUSE_KEY = 'nbdHeroVideoPaused';
  function storedPause() { try { return window.sessionStorage.getItem(PAUSE_KEY) === '1'; } catch (e) { return false; } }
  function storePause(on) { try { if (on) window.sessionStorage.setItem(PAUSE_KEY, '1'); else window.sessionStorage.removeItem(PAUSE_KEY); } catch (e) { /* private mode: this page only */ } }
  if (storedPause()) return; // paused earlier this visit: the still hero, like reduced motion

  var PAUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>';
  var PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';

  function wire(v) {
    var visible = false;
    var loaded = false;
    var userPaused = false;
    var btn = null;
    v.muted = true;
    v.defaultMuted = true;

    // The button goes beside the .hv layer, not inside it: .hv sits under the
    // hero's words (pointer-events:none, z-index 0).
    function syncBtn() {
      if (!btn) return;
      btn.setAttribute('aria-pressed', userPaused ? 'true' : 'false');
      btn.setAttribute('aria-label', userPaused ? 'Play background video' : 'Pause background video');
      btn.innerHTML = userPaused ? PLAY_ICON : PAUSE_ICON;
    }
    function addButton() {
      var layer = v.parentNode;
      if (btn || !layer || !layer.parentNode) return;
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hv-toggle';
      syncBtn();
      btn.addEventListener('click', function () {
        userPaused = !userPaused;
        storePause(userPaused);
        if (userPaused) v.pause(); else play();
        syncBtn();
      });
      layer.parentNode.insertBefore(btn, layer.nextSibling);
    }

    v.addEventListener('playing', function () { v.classList.add('is-playing'); addButton(); });
    v.addEventListener('error', function () { v.classList.remove('is-playing'); });

    function play() {
      if (userPaused || !visible || document.hidden || reduce.matches) return;
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
