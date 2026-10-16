/**
 * playbook-form.js — the optional "Email me the playbook" form on
 * /pro/playbook (2026-10-16). The playbook itself is free to read on the page;
 * this only sends a copy by email.
 *
 * Posts through public-lead-submit.js (submitPublicLead → guide_leads). The
 * server then alerts Jo and sends ONE welcome email with the link
 * (functions/pro-prospects.js). The optional box records consent to a few
 * follow-up tips; unticked means the playbook email only. A failed save is
 * never shown as success. No inline script (CSP): loaded with defer.
 */
(function () {
  'use strict';
  const form = document.getElementById('playbookForm');
  if (!form) return;
  const msg = document.getElementById('playbookFormMsg');
  const btn = form.querySelector('button[type="submit"]');

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

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    const hp = form.querySelector('input[name="nbd_hp"]');
    if (hp && hp.value) return;
    const name = (form.querySelector('input[name="name"]').value || '').trim();
    const email = (form.querySelector('input[name="email"]').value || '').trim();
    const consent = form.querySelector('input[name="emailConsent"]');
    if (!name || !email) { say('err', 'Please add your name and email.'); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    let res = null;
    try {
      if (typeof window.submitPublicLead === 'function') {
        res = await window.submitPublicLead('guide', Object.assign({
          name: name, email: email, source: 'pro-playbook',
          emailConsent: !!(consent && consent.checked)
        }, utm()));
      }
    } catch (err) { res = null; }
    if (btn) { btn.disabled = false; btn.textContent = 'Email me the playbook'; }
    if (!res || !res.ok) {
      say('err', "That didn't go through. Try again in a minute, or email jd@nobigdealwithjoedeal.com and I'll send it.");
      return;
    }
    form.reset();
    say('ok', "Done. Check your inbox for the link in the next few minutes (and your spam folder, just in case).");
  });
})();
