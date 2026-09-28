/**
 * sign-page.js — public remote-signing page logic (Signatures PR4)
 *
 * Drives /pro/sign.html. No Firebase auth — the only credential is the
 * ?token= in the URL, validated server-side by the getSignDocument /
 * submitSignature Cloud Functions (functions/remote-signing.js).
 *
 * Flow:
 *   1. read token from the query string
 *   2. POST getSignDocument({token}) → the interactive doc HTML
 *   3. srcdoc it into the sandboxed iframe (the doc loads signature-
 *      widget.js itself, via the generator's _injectSignatureAssets)
 *   4. on Submit, postMessage {__nbd_sig:'finalize'} to the iframe →
 *      it bakes the canvases into <img> PNGs and returns the signed HTML
 *   5. POST submitSignature({token, signedHtml}) → done (token burned)
 */
(function () {
  'use strict';

  // sign.html now loads js/toast.js before this file, so showToast exists.
  // These are recoverable validation errors — the signer stays on the page
  // and the submit button is re-enabled — so a toast is right. Terminal
  // states still take over the whole panel via msg() below.
  function _spNotify(text, kind) {
    if (typeof window.showToast === 'function') { window.showToast(text, kind || 'info'); return; }
    if (kind === 'error') console.error('[sign]', text); else console.log('[sign]', text);
  }

  // Localhost-only emulator switch (same Audit #3 rule as
  // nbd-emulator-connect.js): the rep-side pages already point their SDK at
  // the emulators when served from localhost, but the public token pages
  // hardcoded prod — leaving the homeowner surface untestable in the
  // hermetic e2e harness. Any hostname other than localhost/127.0.0.1
  // keeps prod.
  var FN_BASE = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)
    ? 'http://127.0.0.1:5001/nobigdeal-pro/us-central1'
    : 'https://us-central1-nobigdeal-pro.cloudfunctions.net';
  var token = new URLSearchParams(location.search).get('token') || '';

  var frame = document.getElementById('spFrame');
  var foot = document.getElementById('spFoot');
  var submitBtn = document.getElementById('spSubmit');
  var docName = document.getElementById('spDocName');

  // ── Phone reading layout (2026-09-25, phone audit homeowner#2) ───
  // The document arrives as a US-letter page at print size (9-10px clause
  // text in a 277px column on a 412px phone). The layout that makes it
  // readable lives in doc-phone-layout.js, shared with the portal's
  // "Your Documents" viewer and the rep's doc viewer (in-person signing),
  // which carried the same print-size document until they shared it. It is
  // added to the copy this page SHOWS and taken back out of what the
  // widget returns before submitSignature sees it, so the signed record is
  // byte-identical to a desktop signer's — see that file for why the
  // layout can never live in the document itself.
  // Since that move only the generator's letter documents (.document-
  // container: contract, proposal, the two inspection reports) get the
  // sheet; #1746 applied it to every document. A .doc-page document (change
  // order, invoice, AOB...) is shown here as served again — deliberately:
  // the sheet was measured against the letter template only, and those
  // templates carry no signature pads, so they cannot be signed here anyway.
  // Read at call time: if that script failed to load, the document is
  // shown and submitted exactly as served (nothing added, nothing to strip).
  function withPhoneLayout(html) {
    var L = window.NBDDocPhoneLayout;
    return L ? L.withPhoneLayout(html) : html;
  }
  function stripPhoneLayout(html) {
    var L = window.NBDDocPhoneLayout;
    return L ? L.stripPhoneLayout(html) : html;
  }

  function msg(icon, title, body) {
    document.getElementById('spMsg').style.display = 'flex';
    document.getElementById('spMsgIcon').innerHTML = icon;
    document.getElementById('spMsgTitle').textContent = title;
    document.getElementById('spMsgBody').textContent = body;
  }
  function hideMsg() { document.getElementById('spMsg').style.display = 'none'; }

  async function post(path, body) {
    var res = await fetch(FN_BASE + '/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    var data = null;
    try { data = await res.json(); } catch (_) {}
    return { ok: res.ok, status: res.status, data: data || {} };
  }

  // ── Load the document ────────────────────────────────────────────
  async function load() {
    if (!token || token.length < 10) {
      msg('⚠️', 'Invalid link', 'This signing link looks incomplete. Please use the button in your email.');
      return;
    }
    var r;
    try { r = await post('getSignDocument', { token: token }); }
    catch (e) { msg('📡', 'Connection problem', 'Could not reach the server. Check your connection and reload.'); return; }

    if (!r.ok) {
      if (r.status === 410) msg('✅', 'Already signed', (r.data.error || 'This document has already been signed — nothing more to do.'));
      else if (r.status === 404) msg('🔗', 'Invalid link', (r.data.error || 'This signing link is not valid.'));
      else if (r.status === 429) msg('⏳', 'Too many tries', 'Please wait a minute and reload.');
      else msg('⚠️', 'Could not load', (r.data.error || 'Something went wrong. Try again shortly.'));
      return;
    }

    if (docName) docName.textContent = r.data.docTypeName ? '· ' + r.data.docTypeName : '';
    // White-label (2026-07-19): tenant signing sessions brand the chrome with
    // the tenant's name (server-resolved, '' for NBD -> literals untouched).
    var brandEl = document.getElementById('spBrand');
    if (r.data.companyName && brandEl) brandEl.textContent = r.data.companyName;
    // sign.html now ships a neutral title and a hidden brand span (another
    // contractor's homeowner saw NBD's name while the document loaded). Once
    // the company is known — the tenant's, or the page's NBD default — show it.
    if (brandEl) {
      brandEl.style.visibility = '';
      try { document.title = 'Review & Sign · ' + brandEl.textContent; } catch (e) {}
    }
    frame.srcdoc = withPhoneLayout(r.data.html || '');
    frame.style.display = 'block';
    frame.addEventListener('load', function () {
      hideMsg();
      foot.style.display = 'flex';
    }, { once: true });
  }

  // ── Finalize bridge (parent ↔ sandboxed widget) ──────────────────
  var pendingResolve = null;
  window.addEventListener('message', function (e) {
    if (!e.data || typeof e.data !== 'object' || e.data.__nbd_sig !== 'finalized') return;
    if (!pendingResolve) return;
    var r = pendingResolve; pendingResolve = null; r(e.data);
  });

  function finalize() {
    return new Promise(function (resolve) {
      pendingResolve = resolve;
      var t = setTimeout(function () {
        if (pendingResolve === resolve) { pendingResolve = null; resolve({ ok: false, timedOut: true }); }
      }, 4000);
      var wrapped = resolve;
      pendingResolve = function (p) { clearTimeout(t); wrapped(p); };
      try { frame.contentWindow.postMessage({ __nbd_sig: 'finalize' }, '*'); }
      catch (err) { clearTimeout(t); pendingResolve = null; resolve({ ok: false, error: err }); }
    });
  }

  // ── Submit ───────────────────────────────────────────────────────
  async function submit() {
    submitBtn.disabled = true;
    var orig = submitBtn.textContent;
    submitBtn.innerHTML = '<span class="spin"></span> Finalizing…';

    var fin = await finalize();
    if (!fin || !fin.ok) {
      submitBtn.disabled = false; submitBtn.textContent = orig;
      if (fin && Array.isArray(fin.missing) && fin.missing.length) {
        _spNotify('Add your signature before submitting.', 'warning');
      } else if (fin && fin.noFields) {
        // This document carries no signature field at all. Saying "try
        // again" would loop the signer forever on something that cannot
        // succeed — tell them the truth and send them back to the rep.
        msg('⚠️', 'This document can’t be signed',
          'It was sent without a signature field. Please contact your rep for a corrected copy — nothing you do here will work.');
        foot.style.display = 'none';
      } else if (fin && fin.noSignature) {
        _spNotify('Draw your signature in the box before submitting.', 'warning');
      } else if (fin && fin.timedOut) {
        _spNotify('The document is still loading — give it a second and try again.', 'warning');
      } else {
        _spNotify('Could not capture the signature. Please try again.', 'error');
      }
      return;
    }

    submitBtn.innerHTML = '<span class="spin"></span> Submitting…';
    var r;
    try { r = await post('submitSignature', { token: token, signedHtml: stripPhoneLayout(fin.html) }); }
    catch (e) { submitBtn.disabled = false; submitBtn.textContent = orig; _spNotify('Connection problem — please try again.', 'error'); return; }

    if (r.ok && r.data.ok) {
      frame.style.display = 'none';
      foot.style.display = 'none';
      msg('🎉', 'All done — thank you!', 'Your signature has been recorded and sent to your rep. You can close this page.');
    } else {
      submitBtn.disabled = false; submitBtn.textContent = orig;
      if (r.status === 409 || r.status === 410) {
        msg('✅', 'Already signed', (r.data.error || 'This document was already signed.'));
        foot.style.display = 'none';
      } else {
        _spNotify(r.data.error || 'Could not submit. Please try again.', 'error');
      }
    }
  }

  submitBtn.addEventListener('click', submit);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
  else load();
})();
