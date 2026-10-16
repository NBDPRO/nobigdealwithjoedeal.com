/**
 * guide-pdf-slot.js — shows a guide's "Download the printable PDF" link only
 * once the PDF actually exists (2026-10-16).
 *
 * The free guides' PDFs are typeset separately (Docs Studio, Typst) and
 * published to /guides/pdf/<slug>.pdf when ready. Until then each page shows
 * "Printable PDF coming soon". Markup:
 *   <a data-pdf-slot data-pdf-href="/guides/pdf/<slug>.pdf" hidden>Download the PDF</a>
 *   <span data-pdf-soon>Printable PDF coming soon</span>
 * The link carries NO href until the file is confirmed, so the page never
 * ships a dead link (and the site-integrity gate never sees one). A
 * same-origin HEAD request decides: only a 200 application/pdf sets the href
 * and shows the link. 404, offline or an HTML error page leave "coming soon".
 * No inline script (CSP): loaded with defer.
 */
(function () {
  'use strict';
  const SLOT_RE = /^\/guides\/pdf\/[a-z0-9-]+\.pdf$/;
  function reveal(link, href) {
    link.setAttribute('href', href);
    link.hidden = false;
    const group = link.closest('[data-pdf-group]') || link.parentNode;
    if (group) group.querySelectorAll('[data-pdf-soon]').forEach(function (s) { s.hidden = true; });
  }
  function check(link) {
    const href = link.getAttribute('data-pdf-href') || '';
    if (!SLOT_RE.test(href) || typeof fetch !== 'function') return;
    fetch(href, { method: 'HEAD', credentials: 'omit', cache: 'no-cache' }).then(function (res) {
      const type = (res.headers.get('content-type') || '').toLowerCase();
      if (res.ok && type.indexOf('application/pdf') !== -1) reveal(link, href);
    }).catch(function () { /* offline: keep "coming soon" */ });
  }
  function init() { document.querySelectorAll('a[data-pdf-slot]').forEach(check); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
