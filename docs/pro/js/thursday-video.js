/**
 * NBD — "A video from Thursday" card (deal room + customer portal).
 *
 * Thursday is NBD's assistant presenter. This card plays a short self-hosted
 * follow-up video from her on two homeowner surfaces, under a plain label
 * (Jo, 2026-10-05: no visible disclosure banner/line on the site):
 *
 *   - dealRoom — /deal/<token>. getDealRoom (functions/deal-acceptance.js)
 *     injects <meta name="nbd-thursday" content="1"> plus this script ONLY
 *     when the deal's companyId is NBD's owner uid. The deal page is
 *     tenant-authored HTML, so the NBD decision is made on the server from the
 *     token doc, never from anything the page says about itself.
 *   - portal  — /pro/portal. functions/portal.js sends company.isNbd (the
 *     lead's companyId === NBD's owner uid); portal.js asks shouldShow().
 *
 * Other tenants never see NBD's Thursday. And nothing renders until a video is
 * configured below: VIDEOS ships with every surface null (dark). To turn a
 * surface on (or swap its video), edit that ONE entry: { src, poster,
 * captions[, label] } as same-origin /assets/ paths (EXIF-stripped poster,
 * WebVTT captions), and bump ?v= where this file is loaded. tests/thursday-video-card-2026-10-05.test.js pins the rules.
 *
 * CSP: no inline script or handlers. The card is built with createElement and
 * styled by /pro/css/thursday-video.css (linked on first render), so it works
 * under the portal's policy and the deal room's default-src 'none' policy
 * (which allows this script by exact path and media-src 'self').
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NBDThursdayVideo = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LABEL = 'A quick video from Thursday';
  var CSS_HREF = '/pro/css/thursday-video.css?v=1';

  // Per-surface video. null = dark (the follow-up video is not produced yet).
  // Shape: { src: '/assets/video/x.mp4', poster: '/assets/img/x.webp',
  //          captions: '/assets/video/x.en.vtt', width: 540, height: 960,
  //          label: 'optional plain label' }
  var VIDEOS = Object.freeze({
    dealRoom: null,
    portal: null,
  });

  // Same-origin asset paths only: a stray absolute URL would be blocked by
  // the deal room's media-src 'self' anyway, and it keeps third-party hosts off
  // a homeowner page.
  var ASSET_PATH = /^\/assets\/[A-Za-z0-9._\/-]+$/;

  function configFor(surface, videos) {
    var all = videos || VIDEOS;
    if (!Object.prototype.hasOwnProperty.call(all, surface)) return null;
    var v = all[surface];
    if (!v || typeof v !== 'object') return null;
    if (!ASSET_PATH.test(String(v.src || ''))) return null;
    if (!ASSET_PATH.test(String(v.poster || ''))) return null;
    if (!ASSET_PATH.test(String(v.captions || ''))) return null;
    return v;
  }

  // isNbd must be exactly true (the server's companyId check) — a truthy
  // string or a company NAME never qualifies.
  function shouldShow(surface, isNbd, videos) {
    return isNbd === true && !!configFor(surface, videos);
  }

  function buildCard(doc, surface, videos) {
    var v = configFor(surface, videos);
    if (!v) return null;
    var card = doc.createElement('section');
    card.className = 'thv thv--' + (surface === 'portal' ? 'portal' : 'deal');
    card.setAttribute('data-thursday-video', surface);
    var text = typeof v.label === 'string' && v.label.trim() ? v.label.trim() : LABEL;
    card.setAttribute('aria-label', text);

    var label = doc.createElement('div');
    label.className = 'thv-label';
    label.textContent = text;
    card.appendChild(label);

    var video = doc.createElement('video');
    video.className = 'thv-video';
    video.setAttribute('controls', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('preload', 'none');
    video.setAttribute('poster', v.poster);
    video.setAttribute('width', String(v.width || 540));
    video.setAttribute('height', String(v.height || 960));
    var source = doc.createElement('source');
    source.setAttribute('src', v.src);
    source.setAttribute('type', 'video/mp4');
    video.appendChild(source);
    var track = doc.createElement('track');
    track.setAttribute('kind', 'captions');
    track.setAttribute('src', v.captions);
    track.setAttribute('srclang', 'en');
    track.setAttribute('label', 'English');
    video.appendChild(track);
    card.appendChild(video);
    return card;
  }

  function ensureCss(doc, then) {
    var existing = doc.querySelector('link[data-thursday-css]');
    if (existing) { then(); return; }
    var link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    link.setAttribute('data-thursday-css', '1');
    var done = false;
    var go = function () { if (!done) { done = true; then(); } };
    // Insert the card only once its styles are in, so it never reflows.
    link.onload = go;
    link.onerror = go;
    (doc.head || doc.documentElement).appendChild(link);
  }

  // The portal re-renders #mainWrap with innerHTML on a poll. Keep one card
  // node per surface and move it into the fresh slot, so a video the
  // homeowner is watching is not torn down mid-play.
  var cache = {};
  function mountInto(slot, surface, isNbd, videos) {
    if (!slot || !shouldShow(surface, isNbd, videos)) return false;
    var doc = slot.ownerDocument;
    if (cache[surface]) {
      slot.parentNode.replaceChild(cache[surface], slot);
      return true;
    }
    var card = buildCard(doc, surface, videos);
    if (!card) return false;
    cache[surface] = card;
    ensureCss(doc, function () {
      if (slot.parentNode) slot.parentNode.replaceChild(card, slot);
    });
    return true;
  }

  // Deal room: the server only adds the meta for an NBD deal.
  function autoMountDealRoom(doc, videos) {
    if (!doc || !doc.querySelector) return false;
    var meta = doc.querySelector('meta[name="nbd-thursday"]');
    if (!meta || meta.getAttribute('content') !== '1') return false;
    if (!configFor('dealRoom', videos)) return false;
    var host = doc.querySelector('.container');
    if (!host) return false;
    var slot = doc.createElement('div');
    host.insertBefore(slot, host.firstChild);
    return mountInto(slot, 'dealRoom', true, videos);
  }

  if (typeof document !== 'undefined' && document.querySelector) {
    try { autoMountDealRoom(document); } catch (_) { /* the page works without the card */ }
  }

  return {
    LABEL: LABEL,
    VIDEOS: VIDEOS,
    configFor: configFor,
    shouldShow: shouldShow,
    buildCard: buildCard,
    mountInto: mountInto,
    autoMountDealRoom: autoMountDealRoom,
  };
});
