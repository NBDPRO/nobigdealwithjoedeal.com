/**
 * sign-link-panel.js — the "Send for Signature" panel for a generated document (2026-11-18,
 * Jo's decisions Q48, Q59, Q60). Flag docSignPanelV1 (default OFF, per person): with the flag on,
 * nbd-doc-viewer.js opens this instead of window.prompt.
 *
 * What the rep sees: a QR code of the single-use signing link (the homeowner scans it and signs on
 * their own phone), plus
 *   Text link        a button (no href) that opens Messages from the rep's own phone only after the server's "ok to text?"
 *                    (NBDPhoneShare.checkText) says yes; any other answer, or a check that cannot
 *                    run, opens nothing and says "Use Email or Copy link instead."
 *   Copy link        the link on the clipboard
 *   Email it         asks for the address INSIDE the panel (validated), then the existing email path
 *   Make a new link  one tap: a new link, the QR is redrawn, the old link stops working
 *
 * The link is a bearer token. The QR holds the link and nothing else (no name, address or phone),
 * and the panel says so: "Anyone with this link can sign: only show it to the homeowner."
 *
 * API: NBDSignLinkPanel.open({
 *        mint(opts) -> Promise<{ signLink, supersededOld?, emailed? }>   opts is { sendEmail:false } for a
 *                                              link-only link, or { email } for the email path
 *        host, phone, leadId, firstName, docLabel, brand, emailDefault })
 *      -> { el, ready, close() }   (ready resolves once the first link is drawn or has failed)
 * No inline handlers (one delegated listener), no innerHTML except the QR SVG our own encoder
 * (qr-code.js) draws, nothing is fetched. Loaded lazily by the viewer, never at boot.
 */
(function (root) {
  'use strict';
  if (!root || !root.document) return;

  var NOTE = 'Anyone with this link can sign: only show it to the homeowner.';
  var TAIL = ' Use Email or Copy link instead.';
  var COULD_NOT_CHECK = 'Couldn’t check whether this customer can be texted — nothing was sent.';
  var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  var SOURCE = 'sign_link'; // not a reply label: the declined-consent rule applies in full (functions/sms-consent-declined.js)
  var current = null;

  function digits(phone) {
    var d = String(phone || '').replace(/\D/g, '');
    if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
    return d.length >= 10 ? d : '';
  }
  function smsHref(phone, body) {
    var d = digits(phone);
    return d ? 'sms:' + d + '?&body=' + encodeURIComponent(String(body || '')) : '';
  }
  function smsBody(o, link) {
    var first = String(o.firstName || '').trim().split(/\s+/)[0];
    var what = String(o.docLabel || '').trim() || 'document';
    var from = String(o.brand || '').trim();
    return 'Hi' + (first ? ' ' + first : '') + ', here is your ' + what + (from ? ' from ' + from : '') + ' to sign: ' + link;
  }

  function ensureStyles() {
    var d = root.document;
    if (d.getElementById && d.getElementById('nbd-sign-link-panel-styles')) return;
    var st = d.createElement('style');
    st.id = 'nbd-sign-link-panel-styles';
    st.textContent = [
      '.slp-scrim{position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;padding:16px;background:color-mix(in srgb,var(--bg,#0b0d10) 82%,transparent);font-family:inherit}',
      '.slp-card{width:100%;max-width:420px;max-height:100%;overflow:auto;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;padding:16px;background:var(--s2,#181c22);color:var(--t,#e8eaf0);border:1px solid var(--br,#2a2f35);border-radius:var(--r-xl,12px);box-shadow:var(--ui-elev-3,0 8px 24px rgba(0,0,0,.4))}',
      '.slp-head{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.slp-title{margin:0;font-size:18px;font-weight:700;line-height:1.2}',
      '.slp-qr{box-sizing:border-box;width:min(260px,70vw);min-height:120px;margin:0 auto;padding:8px;background:#fff;border-radius:var(--r-md,8px);color:#12223d;font-size:14px;display:flex;align-items:center;justify-content:center;text-align:center}',
      '.slp-qr svg{display:block;width:100%;height:auto}',
      '.slp-status{min-height:20px;margin:0;font-size:14px;line-height:1.35;color:var(--m,#9aa3b2)}',
      '.slp-status.slp-bad{color:var(--red,#dc2626)}',
      '.slp-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
      '.slp-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 14px;font:inherit;font-size:14px;font-weight:700;text-decoration:none;cursor:pointer;color:var(--t,#e8eaf0);background:var(--s3,#20252c);border:1px solid var(--br,#2a2f35);border-radius:var(--r-md,8px);-webkit-tap-highlight-color:transparent;touch-action:manipulation}',
      '.slp-btn:hover{border-color:var(--orange,#BD5728)}',
      '.slp-btn:focus-visible,.slp-input:focus-visible{outline:2px solid var(--orange,#BD5728);outline-offset:2px}',
      '.slp-btn.slp-primary{background:var(--orange,#BD5728);border-color:var(--orange,#BD5728);color:var(--accent-fg,#fff)}',
      '.slp-btn[aria-disabled="true"],.slp-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.slp-row{display:flex;flex-direction:column;gap:6px}',
      '.slp-row[hidden]{display:none}',
      '.slp-label{font-size:14px;font-weight:700}',
      '.slp-input{box-sizing:border-box;width:100%;min-height:44px;padding:0 12px;font:inherit;font-size:16px;color:var(--t,#e8eaf0);background:var(--s,#111418);border:1px solid var(--br,#2a2f35);border-radius:var(--r-md,8px)}',
      '.slp-note{margin:0;font-size:13px;line-height:1.35;color:var(--m,#9aa3b2)}',
      '@media (max-width:420px){.slp-scrim{align-items:flex-end;padding:8px}.slp-card{padding:14px}}'
    ].join('\n');
    (d.head || d.body).appendChild(st);
  }

  function open(o) {
    o = o || {};
    var d = root.document;
    if (current) { try { current.close(); } catch (_) { /* already gone */ } }
    ensureStyles();

    function mk(tag, cls, text) {
      var e = d.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }
    function act(tag, name, label, cls) {
      var e = mk(tag, 'slp-btn' + (cls ? ' ' + cls : ''), label);
      if (tag === 'button') e.setAttribute('type', 'button');
      e.setAttribute('data-sl-action', name);
      return e;
    }

    var card = mk('div', 'slp-card');
    var scrim = mk('div', 'slp-scrim');
    scrim.setAttribute('role', 'dialog');
    scrim.setAttribute('aria-modal', 'true');
    scrim.setAttribute('aria-label', 'Signing link for the homeowner');
    scrim.appendChild(card);

    var head = mk('div', 'slp-head');
    var title = mk('h2', 'slp-title', 'Homeowner signs on their phone');
    var closeBtn = act('button', 'close', 'Close');
    closeBtn.setAttribute('aria-label', 'Close the signing link');
    head.appendChild(title); head.appendChild(closeBtn);

    var qr = mk('div', 'slp-qr', 'Making the link…');
    var status = mk('p', 'slp-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    var hasPhone = !!digits(o.phone);
    // A <button>, never an <a href="sms:">: with a real href, long-press / middle-click / "Open" reach Messages without the
    // "ok to text?" check (security review 2026-11-18, item 2). The sms: URL is built and opened only after the check says yes.
    var textBtn = act('button', 'text', 'Text link', 'slp-primary');
    if (!hasPhone) textBtn.setAttribute('aria-disabled', 'true');
    var copyBtn = act('button', 'copy', 'Copy link');
    var emailBtn = act('button', 'email', 'Email it');
    var newBtn = act('button', 'new', 'Make a new link');
    var actions = mk('div', 'slp-actions');
    [textBtn, copyBtn, emailBtn, newBtn].forEach(function (b) { actions.appendChild(b); });

    var emailRow = mk('div', 'slp-row');
    emailRow.hidden = true; emailRow.setAttribute('hidden', '');
    var emailLabel = mk('label', 'slp-label', 'Email the link to');
    emailLabel.setAttribute('for', 'slp-email');
    var emailInput = mk('input', 'slp-input');
    emailInput.setAttribute('type', 'email');
    emailInput.setAttribute('id', 'slp-email');
    emailInput.setAttribute('inputmode', 'email');
    emailInput.setAttribute('autocomplete', 'off');
    emailInput.setAttribute('aria-label', 'Homeowner email address');
    emailInput.setAttribute('placeholder', 'name@example.com');
    emailInput.value = String(o.emailDefault || '');
    var emailSend = act('button', 'email-send', 'Send email');
    emailRow.appendChild(emailLabel); emailRow.appendChild(emailInput); emailRow.appendChild(emailSend);

    var linkLabel = mk('label', 'slp-label', 'Link');
    linkLabel.setAttribute('for', 'slp-link');
    var linkInput = mk('input', 'slp-input');
    linkInput.setAttribute('type', 'text');
    linkInput.setAttribute('id', 'slp-link');
    linkInput.setAttribute('readonly', '');
    linkInput.setAttribute('aria-label', 'Signing link');
    var linkRow = mk('div', 'slp-row');
    linkRow.appendChild(linkLabel); linkRow.appendChild(linkInput);

    var note = mk('p', 'slp-note', NOTE);

    [head, qr, status, actions, emailRow, linkRow, note].forEach(function (n) { card.appendChild(n); });

    var link = '';
    var busy = false;
    var closed = false;

    function say(msg, bad) {
      status.textContent = msg || '';
      status.className = 'slp-status' + (bad ? ' slp-bad' : '');
    }
    function drawQr() {
      if (!link) { qr.innerHTML = ''; qr.textContent = 'No link yet.'; return; }
      var Q = root.NBDQr;
      if (Q && typeof Q.svg === 'function') {
        try { qr.textContent = ''; qr.innerHTML = Q.svg(link, { label: 'QR code for the signing link' }); return; } catch (_) { /* too long for the encoder: fall through */ }
      }
      qr.innerHTML = '';
      qr.textContent = 'The QR code is not available. Use Text link, Copy link or Email it.';
    }
    function setLink(next) {
      link = String(next || '');
      linkInput.value = link;
      drawQr();
    }
    function fail(e, what) {
      var m = (e && e.message) ? String(e.message) : '';
      say(m || (what + ' did not work. Try again.'), true);
    }

    function newLink(isRemake) {
      if (busy || closed) return Promise.resolve();
      busy = true; say('Making the link…');
      return Promise.resolve().then(function () { return o.mint({ sendEmail: false }); }).then(function (r) {
        if (!r || !r.signLink) throw new Error('No link came back. Try again.');
        setLink(r.signLink);
        if (isRemake && r.supersedeError === true) say('New link ready, but we could not confirm the old link was turned off. Make another link if unsure.', true);
        else say(isRemake && r.supersededOld === true ? 'New link ready. The old link no longer works.' : (isRemake ? 'New link ready.' : 'Link ready. The homeowner can scan the code.'));
      }).catch(function (e) {
        setLink('');
        fail(e, 'Making the link');
      }).then(function () { busy = false; });
    }

    function sendEmail() {
      if (busy || closed) return Promise.resolve();
      var addr = String(emailInput.value || '').trim();
      if (!EMAIL_RE.test(addr)) { say('Enter a valid email address, like name@example.com.', true); return Promise.resolve(); }
      busy = true; say('Sending…');
      return Promise.resolve().then(function () { return o.mint({ email: addr }); }).then(function (r) {
        if (!r || !r.signLink) throw new Error('No link came back. Try again.');
        setLink(r.signLink);
        say(r.emailed ? 'Emailed to ' + addr + '. The code above is that same link.' : 'The link is made, but the email did not go out. Use Text link or Copy link instead.', !r.emailed);
      }).catch(function (e) { fail(e, 'Sending the email'); }).then(function () { busy = false; });
    }

    function copy() {
      if (!link) { say('There is no link to copy yet.', true); return Promise.resolve(); }
      function fallback() {
        try { linkInput.focus(); linkInput.select(); if (linkInput.setSelectionRange) linkInput.setSelectionRange(0, link.length); } catch (_) { /* selecting is best effort */ }
        var done = false;
        try { done = !!root.document.execCommand('copy'); } catch (_) { done = false; }
        say(done ? 'Link copied.' : 'Press and hold the link below to copy it.', !done);
      }
      var cb = root.navigator && root.navigator.clipboard;
      if (cb && typeof cb.writeText === 'function') {
        return Promise.resolve().then(function () { return cb.writeText(link); }).then(function () { say('Link copied.'); }, fallback);
      }
      fallback();
      return Promise.resolve();
    }

    function text() {
      if (!link) { say('There is no link to text yet.' + TAIL, true); return Promise.resolve(); }
      if (!hasPhone) { say('No phone number on file for this customer.' + TAIL, true); return Promise.resolve(); }
      var PS = root.NBDPhoneShare;
      var chkOpts = { phone: o.phone, leadId: o.leadId, source: SOURCE };
      return Promise.resolve().then(function () {
        return (PS && typeof PS.checkText === 'function') ? PS.checkText(chkOpts) : null;
      }).catch(function () { return null; }).then(function (chk) {
        if (!chk || chk.ok !== true) { say(((chk && chk.reason) || COULD_NOT_CHECK) + TAIL, true); return; }
        if (closed || !link) return; // closed (or the link was dropped) while the check ran
        var href = smsHref(o.phone, smsBody(o, link));
        if (!href) { say('No phone number on file for this customer.' + TAIL, true); return; }
        // The record of the send, like the estimate flow's Comm Log entry: the words without the bearer link.
        try { if (PS && typeof PS.logSent === 'function') PS.logSent(chkOpts, smsBody(o, '[signing link]')); } catch (_) { /* the log is best effort */ }
        say('Messages is opening with the link written in.');
        try { root.location.href = href; } catch (_) { say('Could not open Messages.' + TAIL, true); }
      });
    }

    function close() {
      if (closed) return;
      closed = true;
      link = ''; linkInput.value = ''; qr.innerHTML = '';
      if (watcher) watcher.disconnect();
      if (scrim.remove) scrim.remove();
      if (current === api) current = null;
    }

    // One delegated listener (no inline handlers, CSP script-src-attr 'none').
    scrim.addEventListener('click', function (ev) {
      var t = ev && ev.target;
      if (t === scrim) { close(); return; }
      var b = t && t.closest ? t.closest('[data-sl-action]') : null;
      var a = b ? b.getAttribute('data-sl-action') : '';
      if (!a) return;
      if (a === 'text') { ev.preventDefault(); text(); }
      else if (a === 'copy') copy();
      else if (a === 'new') newLink(true);
      else if (a === 'close') close();
      else if (a === 'email') {
        emailRow.hidden = false; emailRow.removeAttribute('hidden');
        try { emailInput.focus(); } catch (_) { /* focus is best effort */ }
      } else if (a === 'email-send') sendEmail();
    });
    scrim.addEventListener('keydown', function (ev) {
      if (!ev) return;
      if (ev.key === 'Escape') { close(); return; }
      if (ev.key === 'Enter' && ev.target === emailInput) { if (ev.preventDefault) ev.preventDefault(); sendEmail(); }
    });

    var host = o.host || d.body;
    host.appendChild(scrim);
    // The signing link must not stay on screen once the viewer that holds it is closed (the viewer drops its "open" class).
    var watcher = null;
    if (host.classList && typeof root.MutationObserver === 'function') {
      try {
        watcher = new root.MutationObserver(function () { if (!host.classList.contains('open')) close(); });
        watcher.observe(host, { attributes: true, attributeFilter: ['class'] });
      } catch (_) { watcher = null; }
    }
    // Start the server's "ok to text?" now so the Text tap stays inside the tap (phone-share.js caches a yes).
    try { if (hasPhone && root.NBDPhoneShare && typeof root.NBDPhoneShare.precheck === 'function') root.NBDPhoneShare.precheck({ phone: o.phone, leadId: o.leadId, source: SOURCE }); } catch (_) { /* the tap asks again */ }
    try { closeBtn.focus(); } catch (_) { /* focus is best effort */ }

    var api = { el: scrim, close: close };
    api.ready = newLink(false);
    current = api;
    return api;
  }

  function loadFile(path, present) {
    var sl = root.ScriptLoader;
    if (present() || !sl || typeof sl.load !== 'function') return Promise.resolve();
    return Promise.resolve(sl.load(path)).catch(function () { /* the panel degrades: no QR, no text check */ });
  }
  /** The viewer's entry point: load the QR encoder and the text check on first use, then open for this document's context. */
  function openFor(ctx, host) {
    return loadFile('js/qr-code.js?v=1', function () { return !!root.NBDQr; })
      .then(function () { return loadFile('js/phone-share.js?v=9', function () { return !!root.NBDPhoneShare; }); })
      .then(function () {
        var p = ctx.signPanelOpts || {}, brand = '';
        try { var b = (typeof root._brand === 'function') ? root._brand() : null; brand = (b && (b.legalName || b.name)) || ''; } catch (_) { brand = ''; }
        return open({
          host: host,
          // { sendEmail:false } = a link with no email (QR / text / copy); { email } = the existing email path.
          mint: function (m) { return (m && m.email) ? ctx.onSendForSignature(m.email) : ctx.onSendForSignature('', { sendEmail: false }); },
          phone: p.signerPhoneDefault || '', leadId: ctx.leadId || '',
          firstName: String(p.signerNameDefault || '').trim().split(/\s+/)[0] || '',
          docLabel: p.docLabel || '', brand: brand, emailDefault: p.signerEmailDefault || ''
        });
      });
  }

  root.NBDSignLinkPanel = { openFor: openFor, __sentinel: 'nbd-sign-link-panel-v1', open: open, closeCurrent: function () { if (current) current.close(); }, _smsHref: smsHref, _smsBody: smsBody };
})(typeof window !== 'undefined' ? window : null);
