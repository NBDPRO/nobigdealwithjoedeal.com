/**
 * tenant-account-ui.js — two owner actions in Settings (2026-10-04,
 * tenant-ready):
 *
 *   • Upload logo (Company Profile): the file goes to the uploadCompanyLogo
 *     callable, which re-encodes it (EXIF / GPS stripped), stores it under
 *     tenant-logos/ and saves a PUBLIC first-party URL
 *     (https://nobigdealwithjoedeal.com/tenant-logo/<company>/<hash>.png) —
 *     never a Storage ?token= link. The Logo URL field shows the result.
 *   • Export all company data (Access → Export & Cleanup): the
 *     exportCompanyData callable returns one ZIP (JSON + CSV of leads,
 *     estimates, invoices, contracts, documents and the photo list), named
 *     after the company.
 *
 * Listeners are delegated by id (no inline handlers — CSP).
 */
(function () {
  'use strict';
  if (window.NBDTenantAccountUI) return;

  function $(id) { return document.getElementById(id); }
  function say(id, text, cls) { var el = $(id); if (el) { el.textContent = text; el.className = 'ta-msg ' + (cls || ''); } }

  async function callable(name, payload) {
    if (!window._httpsCallable || !window._functions) {
      var mod = await import('/assets/vendor/firebase/10.12.2/firebase-functions.js');
      window._functions = window._functions || mod.getFunctions();
      window._httpsCallable = window._httpsCallable || mod.httpsCallable;
    }
    var res = await window._httpsCallable(window._functions, name)(payload || {});
    return res && res.data;
  }

  function readAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result || '')); };
      r.onerror = function () { reject(r.error || new Error('read failed')); };
      r.readAsDataURL(file);
    });
  }

  var MAX_BYTES = 3 * 1024 * 1024;

  async function uploadLogo() {
    var input = $('cp_logoFile');
    var file = input && input.files && input.files[0];
    if (!file) { say('cp_logoMsg', 'Choose an image first.', 'is-warn'); return; }
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { say('cp_logoMsg', 'Use a PNG, JPG, WebP or GIF image.', 'is-warn'); return; }
    if (file.size > MAX_BYTES) { say('cp_logoMsg', 'That image is over 3 MB — choose a smaller one.', 'is-warn'); return; }
    var btn = $('cp_logoUpload');
    if (btn) btn.disabled = true;
    say('cp_logoMsg', 'Uploading…');
    try {
      var dataUrl = await readAsDataUrl(file);
      var out = await callable('uploadCompanyLogo', { image: dataUrl });
      var url = out && out.logoUrl;
      if (!url) throw new Error('No logo URL came back');
      var field = $('cp_brand_logoUrl');
      if (field) field.value = url;
      if (typeof window._loadCompanyProfile === 'function') { try { await window._loadCompanyProfile(); } catch (_) { /* repaint next open */ } }
      say('cp_logoMsg', '✓ Logo saved for your company', 'is-ok');
    } catch (e) {
      say('cp_logoMsg', (e && e.message) || 'Upload failed — try again.', 'is-warn');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function b64ToBlob(b64, type) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: type });
  }

  async function exportAll() {
    var btn = $('taExportAll');
    if (btn) btn.disabled = true;
    say('taExportMsg', 'Building your export — this can take a minute…');
    try {
      var out = await callable('exportCompanyData', {});
      if (!out || !out.base64) throw new Error('The export came back empty.');
      var blob = b64ToBlob(out.base64, 'application/zip');
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = out.filename || 'company-export.zip';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
      say('taExportMsg', '✓ ' + a.download + ' downloaded', 'is-ok');
    } catch (e) {
      say('taExportMsg', (e && e.message) || 'Export failed — try again.', 'is-warn');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    if (t.closest('#cp_logoUpload')) { e.preventDefault(); uploadLogo(); return; }
    if (t.closest('#taExportAll')) { e.preventDefault(); exportAll(); }
  });

  window.NBDTenantAccountUI = { uploadLogo: uploadLogo, exportAll: exportAll };
})();
