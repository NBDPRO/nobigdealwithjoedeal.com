/**
 * clarity-loader.js — Microsoft Clarity (heatmaps + session replay) for the
 * PUBLIC marketing site only (2026-10-01, Jo: "integrate microsoft clarity
 * for our website").
 *
 * Inert until PROJECT_ID is set (Clarity → your project → Settings → Setup;
 * the ID is the short code in the tag URL). Even with an ID it only loads when
 * ALL of these hold:
 *   - the page is on the production domain (never preview channels, the
 *     emulator, localhost or CI, which would pollute the data);
 *   - the path is not /pro, /admin, /dev or /sites (the CRM, homeowner portal
 *     and tenant microsites show customer names, addresses and phone numbers,
 *     and must never be recorded; scripts/add-clarity-tag.js also never puts
 *     this file on those pages);
 *   - the browser sends neither Global Privacy Control nor Do Not Track.
 * In the Clarity dashboard set Masking to "Strict" so no page text is
 * captured either; form inputs are masked in every mode.
 *
 * Loaded with defer from every public page right after the GA4 init line.
 * CSP: www.clarity.ms + scripts.clarity.ms (script), *.clarity.ms + c.bing.com
 * (connect, img) on the `**` rule in firebase.json.
 */
(function () {
  'use strict';
  var PROJECT_ID = '';

  try {
    if (!/^[a-z0-9]{6,16}$/i.test(PROJECT_ID)) return;
    var host = location.hostname;
    if (host !== 'nobigdealwithjoedeal.com' && host !== 'www.nobigdealwithjoedeal.com') return;
    if (/^\/(pro|admin|dev|sites)(\/|$)/i.test(location.pathname)) return;
    if (navigator.globalPrivacyControl === true) return;
    if (navigator.doNotTrack === '1' || window.doNotTrack === '1') return;

    window.clarity = window.clarity || function () { (window.clarity.q = window.clarity.q || []).push(arguments); };
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.clarity.ms/tag/' + PROJECT_ID;
    document.head.appendChild(s);
  } catch (e) { /* analytics must never break the page */ }
})();
