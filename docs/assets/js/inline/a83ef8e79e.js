/* @generated — extracted from inline <script> by audit-homeowner-2026-05-22.
   Hash: a83ef8e79e.  Do not edit by hand. */
document.querySelectorAll('.faq-q').forEach(q => {
  q.addEventListener('click', () => {
    const item = q.parentElement;
    const wasOpen = item.classList.contains('open');
    document.querySelectorAll('.faq-item').forEach(i => i.classList.remove('open'));
    if (!wasOpen) item.classList.add('open');
  });
});
// Announcement-bar rotation retired here 2026-11-27 (a11y pass,
// documentation/audit/A11Y-LEAD-PAGES-2026-11-27.md): every page that loads this
// file also loads /assets/js/ann-bar.js, which owns the rotation (one timer,
// reduced motion, pause on hover/focus, a Pause button).
