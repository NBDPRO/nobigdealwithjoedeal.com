/**
 * umami-loader.js — cookie-free page analytics (Umami) for the PUBLIC
 * homeowner site only (2026-10-16; repos report item 10). OFF by default.
 *
 * Nothing loads this file yet. `node scripts/umami.mjs --enable <websiteId>`
 * fills WEBSITE_ID below, adds this loader's tag to the public pages (the
 * pages that carry clarity-loader.js: never /pro, /admin, /dev or /sites) and
 * adds the Umami host to the CSP in firebase.json. `--disable` takes all
 * three back out. See documentation/runbooks/UMAMI-ANALYTICS.md.
 *
 * Even when enabled it only loads when ALL of these hold:
 *   - WEBSITE_ID is a UUID;
 *   - the page is on the production domain (never previews, the emulator,
 *     localhost or CI);
 *   - the path is not /pro, /admin, /dev or /sites (customer data);
 *   - the browser sends neither Global Privacy Control nor Do Not Track.
 * Umami sets no cookies and stores no personal data; its tracker honours
 * Do Not Track as well (data-do-not-track).
 */
(function () {
  'use strict';
  var WEBSITE_ID = '';
  var SCRIPT_URL = 'https://cloud.umami.is/script.js';

  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(WEBSITE_ID)) return;
    var host = location.hostname;
    if (host !== 'nobigdealwithjoedeal.com' && host !== 'www.nobigdealwithjoedeal.com') return;
    if (/^\/(pro|admin|dev|sites)(\/|$)/i.test(location.pathname)) return;
    if (navigator.globalPrivacyControl === true) return;
    if (navigator.doNotTrack === '1' || window.doNotTrack === '1') return;

    var s = document.createElement('script');
    s.defer = true;
    s.src = SCRIPT_URL;
    s.setAttribute('data-website-id', WEBSITE_ID);
    s.setAttribute('data-do-not-track', 'true');
    s.setAttribute('data-domains', 'nobigdealwithjoedeal.com,www.nobigdealwithjoedeal.com');
    document.head.appendChild(s);
  } catch (e) { /* analytics must never break the page */ }
})();
