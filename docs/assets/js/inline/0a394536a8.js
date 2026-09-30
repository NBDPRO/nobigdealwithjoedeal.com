/* @generated — extracted from inline <script> by audit-homeowner-2026-05-22.
   Hash: 0a394536a8.  Do not edit by hand. */
(function(){
  const form = document.getElementById('freeRoofForm');
  const btn  = document.getElementById('fr-submit');
  const out  = document.getElementById('fr-result');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    out.className = 'form-result';
    out.textContent = '';

    const fd = new FormData(form);
    // Honeypot — if the hidden field is filled, silently pretend success.
    // (nbd_hp since 2026-08-05; a field named "website" gets browser-autofilled.)
    if ((fd.get('nbd_hp') || '').toString().trim() !== '') {
      out.className = 'form-result success';
      out.textContent = 'Thanks — entry received.';
      form.reset();
      return;
    }

    const payload = {};
    for (const [k, v] of fd.entries()) {
      if (k === 'nbd_hp' || k === 'website') continue;
      payload[k] = (v || '').toString().trim();
    }

    // The form is novalidate and nothing checked its "required" fields, so a
    // missing one reached the gateway and came back as a bare failure
    // (2026-09-30). Same rules as every public form: a 10-digit phone and a
    // street address (number + street).
    const phoneOk = (payload.phone || '').replace(/\D/g, '').replace(/^1/, '').length === 10;
    const addr = payload.address || '';
    const addressOk = addr.length >= 6 && /\d/.test(addr) && /[a-z]/i.test(addr);
    if (!payload.nomineeName || !phoneOk || !addressOk || !payload.story) {
      out.className = 'form-result error';
      out.textContent = 'Please fill in the homeowner\'s name, a 10-digit phone number, the street address, and their story.';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Submitting…';

    try {
      const res = await window.submitPublicLead('free_roof', payload);
      if (res && res.ok) {
        out.className = 'form-result success';
        out.textContent = 'Entry received. I read every one personally — if I have questions I\'ll call.';
        form.reset();
      } else {
        out.className = 'form-result error';
        out.textContent = 'Something went wrong. Text Joe at (859) 420-7382 if this keeps happening.';
      }
    } catch (err) {
      out.className = 'form-result error';
      out.textContent = 'Couldn\'t reach the server. Please try again or text Joe at (859) 420-7382.';
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M3 11 L12 3 L21 11"/><path d="M5 10 V20 H19 V10"/></svg> Submit Entry';
    }
  });
})();
