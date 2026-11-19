/**
 * doc-phone-layout-letterhead.js: phone layout for the .doc-page / .letterhead
 * documents (invoice, receipt, supplement request, financing options, company
 * intro). Three-size format pass, 2026-11-18: at 390px their header collided
 * with its contact lines, the line-item table ran off the screen and the
 * two-up grids were squeezed into half-width columns.
 *
 * It extends window.NBDDocPhoneLayout (doc-phone-layout.js, loaded first) the
 * same way: a screen-only sheet added to the copy a surface SHOWS, stripped
 * before anything is stored, printed or PDF'd. Letter documents still get the
 * base sheet. It lives in its own file, loaded by the homeowner pages only
 * (portal.html, sign.html), so the dashboard and customer bundles do not grow.
 * Absent, documents show exactly as served.
 */
(function () {
  'use strict';
  var base = window.NBDDocPhoneLayout;
  if (!base || base.DOC_PAGE_STYLE_ID) return;

  var ID = 'nbd-doc-phone-lh';
  var CSS = [
    '@media screen and (max-width:600px){',
    '.doc-page{padding:20px 16px!important;max-width:none!important;}',
    '.letterhead{margin:-20px -16px 20px!important;padding:18px 16px!important;flex-direction:column!important;align-items:flex-start!important;gap:12px!important;}',
    '.letterhead-brand{flex-wrap:wrap;}',
    '.letterhead-logo-img{width:120px!important;}',
    '.letterhead-name{font-size:18px!important;}',
    '.letterhead-tagline{font-size:13px!important;}',
    '.letterhead-contact{text-align:left!important;font-size:13px!important;flex-shrink:1!important;}',
    // Inline-styled flex rows (title + dates) wrap; inline two-up grids stack.
    '.doc-page div[style*="justify-content:space-between"]{flex-wrap:wrap;gap:12px;}',
    '.doc-page [style*="grid-template-columns"]{grid-template-columns:1fr!important;}',
    '.plan-grid{grid-template-columns:1fr!important;}',
    '.plan-card{padding:16px!important;}',
    '.items{display:block;max-width:100%;overflow-x:auto;}',
    '.items th,.items td{padding:8px 6px!important;font-size:13px!important;}',
    '.items td:first-child{overflow-wrap:anywhere;hyphens:auto;}',
    '.inv-balance,.rct-paid{padding:16px!important;}',
    '.inv-balance-amount,.rct-paid-amount{font-size:30px!important;}',
    '.pay-panel{padding:14px!important;}',
    '.footer{margin:24px -16px -20px!important;padding:16px!important;flex-wrap:wrap;font-size:12px!important;}',
    '}',
  ].join('');
  var STYLE = '<style id="' + ID + '">' + CSS + '</style>';
  var DOC_PAGE = /<[a-z][^>]*\sclass\s*=\s*["'][^"']*\bdoc-page\b/i;

  function withPhoneLayout(html) {
    var out = base.withPhoneLayout(html);
    // A letter document already got its sheet; anything else with .doc-page gets this one.
    if (out !== html || typeof html !== 'string' || !DOC_PAGE.test(html)) return out;
    var at = html.search(/<\/head>/i);
    if (at < 0) return html; // no </head>: shown as served (a <style> before the doctype is quirks mode)
    return html.slice(0, at) + STYLE + html.slice(at);
  }
  function stripPhoneLayout(html) {
    var out = base.stripPhoneLayout(html);
    return typeof out === 'string' ? out.split(STYLE).join('') : out;
  }

  window.NBDDocPhoneLayout = Object.freeze({
    STYLE_ID: base.STYLE_ID,
    DOC_PAGE_STYLE_ID: ID,
    withPhoneLayout: withPhoneLayout,
    stripPhoneLayout: stripPhoneLayout,
  });
})();
