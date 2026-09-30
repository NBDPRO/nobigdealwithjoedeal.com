/**
 * intake-extras.js — the extra intake every homeowner service form now asks
 * (Jo, 2026-09-30): a REQUIRED scheduling choice (book a time now, or "please
 * contact me to coordinate"), photos, best time to reach, insurance claim,
 * and how they heard about us.
 *
 *   NBDIntake.html(prefix, opts)     → markup for the block (static pages paste
 *                                      the same markup; JS-built forms call it)
 *   NBDIntake.read(root, prefix)     → { error } | { fields, files }
 *   NBDIntake.afterSubmit(box, info) → uploads photos with the submission's
 *                                      one-time photoToken, then shows the
 *                                      calendar button (prefilled) when the
 *                                      homeowner chose to book, and the photo
 *                                      result / text-us fallback
 *   NBDIntake.calendarUrl(info)      → Cal.com link prefilled with their details
 *
 * Photos are downscaled in the browser (≤2048px JPEG) before upload so a
 * phone photo is ~0.5 MB, and the server (functions/public-lead-photos.js)
 * decodes and re-encodes each one — EXIF/GPS never reaches storage. The
 * submission itself never waits on photos: the lead is saved first.
 *
 * Classic script; no inline handlers (CSP); its stylesheet is linked, not
 * injected inline, so the stricter report-only policy stays clean.
 */
(function () {
  'use strict';
  if (window.NBDIntake) return;

  const MAX_PHOTOS = 10;
  const MAX_EDGE = 2048;
  // NBD's own forms. A contractor microsite passes its own name / phone and,
  // having no booking link, calUrl:null — then only "contact me" is offered
  // (still a required click) and nothing says "Joe".
  const DEFAULTS = { who: 'Joe', phoneDisplay: '(859) 420-7382', phoneTel: '+18594207382', calUrl: 'https://cal.com/nobigdeal/roof-inspection' };
  const _optsByPrefix = {};
  const textLine = (o) => (o.phoneTel ? 'Or text photos to <a href="sms:' + esc(o.phoneTel) + '">' + esc(o.phoneDisplay || o.phoneTel) + '</a>.' : '');
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Stylesheet, once per page.
  if (!document.querySelector('link[data-nbd-intake-css]')) {
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = '/assets/css/intake-extras.css?v=1'; l.setAttribute('data-nbd-intake-css', '');
    document.head.appendChild(l);
  }

  function html(p, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    _optsByPrefix[p] = o;
    const insurance = o.insurance !== false;
    return '' +
      '<fieldset class="nbd-intake-sched" id="' + p + 'Sched">' +
        '<legend>How should we schedule? <span class="nbd-intake-req">*</span></legend>' +
        (o.calUrl ? '<label class="nbd-intake-choice"><input type="radio" name="' + p + 'Scheduling" value="calendar"> <span><b>Pick a date &amp; time now</b><small>The calendar opens right after you send this.</small></span></label>' : '') +
        '<label class="nbd-intake-choice"><input type="radio" name="' + p + 'Scheduling" value="contact_me"> <span><b>Please contact me to coordinate scheduling</b><small>' + esc(o.who) + ' will call or text you to set a time.</small></span></label>' +
      '</fieldset>' +
      '<div class="nbd-intake-row">' +
        '<label class="nbd-intake-field">Best time to reach you<select id="' + p + 'BestTime"><option value="">Any time</option><option>Morning</option><option>Afternoon</option><option>Evening</option><option>Text me first</option></select></label>' +
        (insurance ? '<label class="nbd-intake-field">Insurance claim?<select id="' + p + 'Insurance"><option value="">—</option><option value="yes">Yes, filing or filed</option><option value="no">No</option><option value="not_sure">Not sure yet</option></select></label>' : '') +
        '<label class="nbd-intake-field">How did you hear about us?<select id="' + p + 'HowHeard"><option value="">—</option><option>Google search</option><option>Google Maps / reviews</option><option>Facebook / Instagram</option><option>Yard sign</option><option>Friend or neighbor</option><option>Door knock / flyer</option><option>AI assistant (ChatGPT, Grok, etc.)</option><option>Other</option></select></label>' +
      '</div>' +
      '<label class="nbd-intake-photos">Photos of the problem <small>(optional, up to ' + MAX_PHOTOS + ')</small>' +
        '<input type="file" id="' + p + 'Photos" accept="image/*" multiple>' +
        '<span class="nbd-intake-hint">Close-ups of damage and a wide shot of the roof or wall help most. ' + textLine(o) + '</span>' +
      '</label>';
  }

  function valOf(root, id) { const e = root.querySelector('#' + id) || document.getElementById(id); return e ? String(e.value || '').trim() : ''; }

  /** Validate + collect. The scheduling choice is REQUIRED. */
  function read(root, p) {
    const picked = root.querySelector('input[name="' + p + 'Scheduling"]:checked');
    if (!picked) {
      const fs = root.querySelector('#' + p + 'Sched');
      // A microsite has no calendar option — don't offer one in the error.
      const hasCal = !!root.querySelector('input[name="' + p + 'Scheduling"][value="calendar"]');
      return { error: hasCal ? 'Choose how you’d like to schedule: pick a time now, or ask us to contact you.' : 'Please check “Please contact me to coordinate scheduling” so we can set a time.', el: fs };
    }
    const input = root.querySelector('#' + p + 'Photos');
    const files = input && input.files ? [...input.files].filter((f) => /^image\//.test(f.type) || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name)) : [];
    if (files.length > MAX_PHOTOS) return { error: 'Please choose up to ' + MAX_PHOTOS + ' photos.', el: input };
    const fields = { scheduling: picked.value };
    const bt = valOf(root, p + 'BestTime'); if (bt) fields.bestTime = bt;
    const ins = valOf(root, p + 'Insurance'); if (ins) fields.insuranceClaim = ins;
    const hh = valOf(root, p + 'HowHeard'); if (hh) fields.howHeard = hh;
    if (files.length) { fields.wantsPhotos = true; fields.photoCount = files.length; }
    return { fields, files };
  }

  // Downscale in the browser; fall back to the original file when the browser
  // cannot decode it (e.g. HEIC outside Safari) — the server decodes it.
  function toDataUrl(file) {
    return new Promise((resolve) => {
      const raw = () => { const r = new FileReader(); r.onload = () => resolve(String(r.result || '')); r.onerror = () => resolve(''); r.readAsDataURL(file); };
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const s = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
          const c = document.createElement('canvas');
          c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          resolve(c.toDataURL('image/jpeg', 0.85));
        } catch (_) { URL.revokeObjectURL(url); raw(); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); raw(); };
      img.src = url;
    });
  }

  async function uploadPhotos(token, files, onEach) {
    const base = typeof window.nbdPublicFunctionsBase === 'function' ? window.nbdPublicFunctionsBase() : '';
    let sent = 0, failed = 0, lastError = '';
    for (let i = 0; i < files.length; i++) {
      try {
        const dataUrl = await toDataUrl(files[i]);
        const r = await fetch(base + '/uploadPublicLeadPhoto', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit', mode: 'cors',
          body: JSON.stringify({ token, dataUrl, caption: String(files[i].name || '').slice(0, 120) }),
        });
        if (r.ok) sent++; else { failed++; lastError = ((await r.json().catch(() => ({}))).error) || ''; }
      } catch (_) { failed++; }
      if (onEach) onEach(i + 1, files.length);
    }
    return { sent, failed, lastError };
  }

  function calendarUrl(info, base) {
    const i = info || {};
    const CAL_URL = base || DEFAULTS.calUrl;
    const q = new URLSearchParams();
    const name = [i.firstName, i.lastName].filter(Boolean).join(' ') || i.name || '';
    if (name) q.set('name', name);
    if (i.email) q.set('email', i.email);
    if (i.phone) q.set('attendeePhoneNumber', i.phone);
    const notes = [i.address ? 'Address: ' + i.address : '', i.service ? 'Service: ' + i.service : ''].filter(Boolean).join(' · ');
    if (notes) q.set('notes', notes);
    return CAL_URL + (q.toString() ? '?' + q.toString() : '');
  }

  /**
   * Call after a successful submit. box = element to render into (appended),
   * info = { fields (the intake fields), files, photoToken, firstName,
   * lastName, name, email, phone, address, service }.
   */
  async function afterSubmit(box, info) {
    if (!box) return;
    const i = info || {};
    const o = Object.assign({}, DEFAULTS, (i.prefix && _optsByPrefix[i.prefix]) || {});
    const TEXT_LINE = textLine(o);
    const cal = () => calendarUrl(i, o.calUrl);
    const wrap = document.createElement('div');
    wrap.className = 'nbd-intake-after';
    box.appendChild(wrap);
    const parts = [];
    if (i.fields && i.fields.scheduling === 'calendar') {
      parts.push('<p><a class="nbd-intake-cal" href="' + esc(cal()) + '" target="_blank" rel="noopener">📅 Pick your date &amp; time →</a></p>');
    } else if (i.fields && i.fields.scheduling === 'contact_me' && !i.quietContact) {
      // quietContact: the host page's own success text already says who
      // will reach out (/inspect), so don't say it twice.
      parts.push('<p class="nbd-intake-note">' + esc(o.who) + ' will reach out to set a time' + (i.fields.bestTime ? ' (' + esc(i.fields.bestTime.toLowerCase()) + ')' : '') + '.</p>');
    }
    const files = i.files || [];
    if (files.length) parts.push('<p class="nbd-intake-note" data-nbd-photo-status>Sending your photos… 0 of ' + files.length + '</p>');
    wrap.innerHTML = parts.join('');
    // Book-now: open the calendar straight away (a new tab keeps the
    // confirmation on screen); the button stays as the fallback if blocked.
    if (i.fields && i.fields.scheduling === 'calendar') {
      try { window.open(cal(), '_blank', 'noopener'); } catch (_) { /* button remains */ }
    }
    if (!files.length) return;
    const status = wrap.querySelector('[data-nbd-photo-status]');
    if (!i.photoToken) { status.innerHTML = 'Your request is in, but the photos could not be attached. ' + TEXT_LINE; return; }
    const r = await uploadPhotos(i.photoToken, files, (n, t) => { status.textContent = 'Sending your photos… ' + n + ' of ' + t; });
    if (!r.failed) status.textContent = '✓ ' + r.sent + ' photo' + (r.sent === 1 ? '' : 's') + ' attached to your request.';
    else status.innerHTML = esc((r.sent ? r.sent + ' photo' + (r.sent === 1 ? '' : 's') + ' attached; ' : '') + r.failed + ' did not upload' + (r.lastError ? ' (' + r.lastError + ')' : '') + '. ') + TEXT_LINE;
  }

  window.NBDIntake = { html, read, afterSubmit, calendarUrl, uploadPhotos, MAX_PHOTOS };

  // Static pages drop <div data-nbd-intake="prefix"></div> where the block
  // goes; it is filled here (data-insurance="false" hides the claim question).
  function mountAll() {
    document.querySelectorAll('[data-nbd-intake]').forEach((el) => {
      if (el.getAttribute('data-nbd-intake-ready')) return;
      const opts = { insurance: el.getAttribute('data-insurance') !== 'false' };
      if (el.hasAttribute('data-who')) opts.who = el.getAttribute('data-who');
      if (el.hasAttribute('data-tel')) { opts.phoneTel = el.getAttribute('data-tel'); opts.phoneDisplay = el.getAttribute('data-phone') || opts.phoneTel; }
      if (el.getAttribute('data-cal') === 'none') opts.calUrl = null;
      el.innerHTML = html(el.getAttribute('data-nbd-intake'), opts);
      el.setAttribute('data-nbd-intake-ready', '1');
    });
    // A chosen scheduling option clears the "choose one" highlight.
    document.addEventListener('change', (ev) => {
      const t = ev.target;
      if (t && t.type === 'radio' && /Scheduling$/.test(t.name || '')) {
        const fs = t.closest('.nbd-intake-sched');
        if (fs) fs.classList.remove('nbd-intake-invalid');
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAll); else mountAll();
})();
