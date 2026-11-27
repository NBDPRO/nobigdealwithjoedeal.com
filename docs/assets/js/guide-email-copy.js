/**
 * guide-email-copy.js — the "Email me a copy" box on the homeowner guides
 * (2026-11-26). The guide stays free to read and download on the page; this
 * only sends the printable PDF by email.
 *
 * Markup (scripts/add-guide-email-copy.js injects it, hidden until this runs,
 * so a reader without JavaScript never meets a form that cannot send):
 *   <section data-guide-copy="<slug>" hidden> … <form id="guideCopyForm"> …
 *
 * Posts through public-lead-submit.js: submitPublicLead('guide_copy', { email,
 * guide, source, emailConsent, zip? }). The ZIP is optional; it lets a
 * storm-tips email go only to people near a real storm. The server emails one
 * copy with the PDF attached (functions/guide-copy-email.js) and files a cold
 * CRM lead. The optional box records consent to storm tips (storm-tips-email.js
 * sends them, dark until Joe turns it on). A failed save is never
 * shown as success. No inline script (CSP): loaded with defer.
 */
(function () {
  'use strict';
  const box = document.querySelector('[data-guide-copy]');
  const form = document.getElementById('guideCopyForm');
  if (!box || !form) return;
  const slug = box.getAttribute('data-guide-copy') || '';
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return;
  box.hidden = false;

  const msg = document.getElementById('guideCopyMsg');
  const btn = form.querySelector('button[type="submit"]');
  const LABEL = btn ? btn.textContent : '';

  function say(kind, text) {
    if (!msg) return;
    msg.hidden = false;
    msg.setAttribute('data-kind', kind);
    msg.textContent = text;
  }

  function utm() {
    const out = {};
    try {
      const q = new URLSearchParams(window.location.search);
      ['utm_source', 'utm_medium', 'utm_campaign'].forEach(function (k) {
        const v = (q.get(k) || '').slice(0, 100);
        if (v) out[k] = v;
      });
    } catch (e) { /* no URLSearchParams: send none */ }
    return out;
  }

  function track(name) {
    try { if (typeof window.gtag === 'function') window.gtag('event', name, { guide: slug }); } catch (e) { /* analytics never blocks */ }
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    const hp = form.querySelector('input[name="nbd_hp"]');
    if (hp && hp.value) return;
    const email = (form.querySelector('input[name="email"]').value || '').trim();
    const consent = form.querySelector('input[name="emailConsent"]');
    const zipEl = form.querySelector('input[name="zip"]');
    const zip = zipEl ? (zipEl.value || '').trim() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
      say('err', 'That email doesn’t look right. Check it and try again.');
      return;
    }
    if (zip && !/^\d{5}$/.test(zip)) {
      say('err', 'Enter a 5-digit ZIP code, or leave it blank.');
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    let res = null;
    try {
      if (typeof window.submitPublicLead === 'function') {
        res = await window.submitPublicLead('guide_copy', Object.assign({
          email: email, guide: slug, source: '/guides/' + slug,
          emailConsent: !!(consent && consent.checked)
        }, zip ? { zip: zip } : {}, utm()));
      }
    } catch (err) { res = null; }
    if (btn) { btn.disabled = false; btn.textContent = LABEL; }
    if (!res || !res.ok) {
      say('err', (res && res.friendly && res.reason) ? res.reason
        : "That didn't go through. Try again in a minute, or use the Download button above.");
      return;
    }
    form.reset();
    track('guide_copy_requested');
    say('ok', "Done. The PDF is on its way to your inbox. If it hasn't arrived in a few minutes, check spam, or download it from the button above.");
  });
})();
