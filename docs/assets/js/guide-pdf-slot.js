/**
 * guide-pdf-slot.js — shows a guide's "Download the printable PDF" link only
 * once the PDF actually exists (2026-10-16).
 *
 * The free guides' PDFs are typeset separately (Docs Studio, Typst) and
 * published to /guides/pdf/<slug>.pdf when ready. Until then each page shows
 * "Printable PDF coming soon". Markup:
 *   <a data-pdf-slot href="/guides/pdf/<slug>.pdf" hidden>Download the PDF</a>
 *   <span data-pdf-soon>Printable PDF coming soon</span>
 * A same-origin HEAD request decides. Anything but a 200 PDF (404, offline,
 * an HTML error page) leaves the link hidden, so a missing file is never a
 * dead link. No inline script (CSP): loaded with defer.
 */
(function () {
  'use strict';
  function reveal(link) {
    link.hidden = false;
    const group = link.closest('[data-pdf-group]') || link.parentNode;
    if (group) group.querySelectorAll('[data-pdf-soon]').forEach(function (s) { s.hidden = true; });
  }
  function check(link) {
    const href = link.getAttribute('href') || '';
    if (!/^\/guides\/pdf\/[a-z0-9-]+\.pdf$/.test(href) || typeof fetch !== 'function') return;
    fetch(href, { method: 'HEAD', credentials: 'omit', cache: 'no-cache' }).then(function (res) {
      const type = (res.headers.get('content-type') || '').toLowerCase();
      if (res.ok && type.indexOf('application/pdf') !== -1) reveal(link);
    }).catch(function () { /* offline: keep "coming soon" */ });
  }
  function init() { document.querySelectorAll('a[data-pdf-slot]').forEach(check); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
