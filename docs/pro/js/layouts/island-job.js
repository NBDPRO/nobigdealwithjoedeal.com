/**
 * layouts/island-job.js — Island Dock on the job view (customer.html), 2026-10-12.
 *
 * The job (customer) page is its own document, so it does not run the layout
 * engine. It only needs to know whether the rep's resolved layout for THIS
 * screen is Island Dock: the engine leaves that in localStorage
 * `nbd_layout_resolved` (the same cache shape-preboot.js reads on the
 * dashboard). When it is, the page opens with a hero image of the house:
 *
 *   - the lead's own cover photo if one is set (what #coverHero already shows,
 *     made big), else
 *   - the earliest inspection / "before" shot, else the earliest photo,
 *     taken from the photo docs the page has ALREADY loaded
 *     (window._customerPhotos / _allPhotos). Nothing is fetched and no URL is
 *     minted: the image is a photo URL the CRM already holds, shown on a page
 *     only a signed-in rep can open.
 *
 * Styling lives in css/layouts/island-job.css (loaded only in that case) and is
 * scoped under html[data-island-job].
 *
 * Classic script; pickHero is require()-able for tests.
 */
(function (root) {
  'use strict';

  function isHttp(u) { return typeof u === 'string' && /^https?:/i.test(u); }
  function photoMs(p) {
    var v = p && (p.capturedAt || p.createdAt || p.uploadedAt);
    if (!v) return 0;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    var t = v instanceof Date ? v.getTime() : Date.parse(v);
    return isFinite(t) ? t : 0;
  }
  function isInspection(p) {
    var ph = String((p && p.phase) || '').toLowerCase();
    if (ph === 'before' || ph === 'inspection') return true;
    var tags = (p && p.tags) || [];
    for (var i = 0; i < tags.length; i++) if (/inspect|before|roof/i.test(String(tags[i]))) return true;
    return false;
  }
  function urlOf(p) {
    if (!p) return '';
    var c = [p.url, p.thumbUrl, p.urls && p.urls.thumb];
    for (var i = 0; i < c.length; i++) if (isHttp(c[i])) return String(c[i]);
    return '';
  }
  /** The hero's image URL: cover, else earliest inspection shot, else earliest photo, else ''. */
  function pickHero(lead, photos) {
    if (lead && isHttp(lead.coverPhotoUrl)) return String(lead.coverPhotoUrl);
    var list = (Array.isArray(photos) ? photos : []).filter(function (p) { return !!urlOf(p); });
    if (!list.length) return '';
    list.sort(function (a, b) { return photoMs(a) - photoMs(b); });
    var pick = null;
    for (var i = 0; i < list.length; i++) { if (isInspection(list[i])) { pick = list[i]; break; } }
    return urlOf(pick || list[0]);
  }
  /** Is Island Dock this screen's resolved layout? cache = parsed nbd_layout_resolved. */
  function wantsIsland(cache, width, coarse) {
    if (!cache || typeof cache !== 'object' || !cache.byDevice) return false;
    var surface = width <= 768 ? 'phone' : (width <= 1180 && coarse ? 'tablet' : 'desktop');
    return cache.byDevice[surface] === 'island';
  }

  var api = { pickHero: pickHero, wantsIsland: wantsIsland };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root || !root.document) return;
  root.NBDIslandJob = api;

  var doc = root.document, de = doc.documentElement;
  var cache = null;
  try { cache = JSON.parse(root.localStorage.getItem('nbd_layout_resolved') || 'null'); } catch (e) { cache = null; }
  var coarse = false;
  try { coarse = !!(root.matchMedia && root.matchMedia('(pointer: coarse)').matches); } catch (e) { /* none */ }
  if (!wantsIsland(cache, root.innerWidth || 1024, coarse)) return;

  de.setAttribute('data-island-job', '1');
  var link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/pro/css/layouts/island-job.css';
  doc.head.appendChild(link);

  function paint() {
    var hero = doc.getElementById('coverHero');
    if (!hero) return false;
    var shown = hero.style.display === 'block';
    if (!shown) {
      var url = pickHero(root._currentLead, (root._customerPhotos && root._customerPhotos.length ? root._customerPhotos : root._allPhotos) || []);
      if (!url) return false;
      hero.style.backgroundImage = 'url("' + url.replace(/"/g, '%22') + '")';
      hero.style.display = 'block';
      shown = true;
    }
    de.classList.toggle('ij-has-hero', shown);
    return shown;
  }
  // The lead and its photos arrive after the page's own scripts: look for a
  // while, then stop. A rep who sets a cover later gets it from renderCoverHero.
  var tries = 0;
  (function tick() {
    var done = paint();
    if (!done && ++tries < 60) setTimeout(tick, 500);
  })();
  root.addEventListener('nbd:photos-loaded', paint);

  // ij-has-hero follows the hero's real visibility. renderCoverHero()
  // (customer-tasks-ui.js) hides it when a cover is cleared, and the class used
  // to stay set, so the name card kept its -56px pull-up over an empty gap.
  var watched = null;
  function syncHeroClass() {
    var hero = doc.getElementById('coverHero');
    de.classList.toggle('ij-has-hero', !!(hero && hero.style.display === 'block'));
  }
  function watchHero() {
    var hero = doc.getElementById('coverHero');
    if (!hero || hero === watched || typeof MutationObserver !== 'function') return !!hero;
    watched = hero;
    new MutationObserver(syncHeroClass).observe(hero, { attributes: true, attributeFilter: ['style', 'hidden', 'class'] });
    syncHeroClass();
    return true;
  }
  var wTries = 0;
  (function waitHero() { if (!watchHero() && ++wTries < 60) setTimeout(waitHero, 500); })();
})(typeof window !== 'undefined' ? window : null);
