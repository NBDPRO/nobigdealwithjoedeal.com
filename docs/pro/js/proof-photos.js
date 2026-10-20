/**
 * proof-photos.js — one shared "attach proof" component (2026-10-19).
 *
 * Used by the Sub payments sorter (sub-payments.js: check photo / Zelle
 * screenshot / receipt on a payment to a sub) and the Customer payment backfill
 * (payment-backfill.js: check image, Zelle screenshot, deposit slip on a payment
 * from a customer). One place for the rules that must not drift:
 *
 *   - images and PDFs only, 25 MB each, at most MAX per payment;
 *   - every image is re-drawn on a canvas and saved as JPEG (max 2000 px): that
 *     drops EXIF and GPS. An image the browser cannot decode is REFUSED, never
 *     uploaded raw. A PDF is stored as is;
 *   - stored under the EXISTING private Storage rules (owner-only read), at a
 *     path the caller chooses (receipts/{uid}/sub-proofs/... or
 *     payment-proofs/{uid}/{invoiceId}/...); Firestore keeps the PATH only,
 *     never a download URL or ?token= link;
 *   - viewing asks Storage for a short-lived URL on demand, for a path that
 *     matches pathOk() only, and shows it in this app (a thumbnail or a new tab).
 *
 * A check carries a MICR line (routing and account numbers). This file never
 * reads the pixels of an image, never OCRs, never logs a file name, size or URL;
 * the photo is stored, shown to the owner, and nothing else.
 *
 * window.NBDProofPhotos + module.exports (the pure parts, for tests).
 */
(function (root) {
  'use strict';

  var MAX_FILES = 6;
  var MAX_BYTES = 25 * 1024 * 1024;
  var MAX_SIDE = 2000;
  // The private places a proof may live. Anything else is never opened. The third is a sub's
  // W-9 / insurance paper (sub-paperwork.js, flag subPaperwork): sub-papers/{companyId}/{subId}/.
  var PATH_RE = /^(?:receipts\/[A-Za-z0-9_-]{1,128}\/sub-proofs|payment-proofs\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,80}|sub-papers\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128})\/[A-Za-z0-9._-]{1,160}$/;

  function pathOk(p) { return typeof p === 'string' && PATH_RE.test(p) && p.indexOf('..') === -1; }
  function isPdfPath(p) { return /\.pdf$/i.test(String(p || '')); }
  function typeOk(file) {
    var t = String((file && file.type) || '');
    return t === 'application/pdf' || /^image\//.test(t);
  }
  /** { ok, reason } for one file the owner picked. */
  function check(file) {
    if (!file) return { ok: false, reason: 'No file' };
    if (!typeOk(file)) return { ok: false, reason: 'Proof must be a photo or a PDF' };
    if (!(Number(file.size) <= MAX_BYTES)) return { ok: false, reason: 'Proof is over the 25MB limit' };
    return { ok: true };
  }
  function safeBase(name) {
    return String(name || 'proof').replace(/\.[A-Za-z0-9]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'proof';
  }

  var API = { MAX_FILES: MAX_FILES, MAX_BYTES: MAX_BYTES, PATH_RE: PATH_RE, pathOk: pathOk, isPdfPath: isPdfPath, check: check, safeBase: safeBase };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (!root || typeof root.document === 'undefined') return;
  var w = root;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };

  /** Re-encode an image (EXIF dropped) or pass a PDF through. Rejects when it cannot. */
  function prepare(file) {
    return new Promise(function (resolve, reject) {
      var c = check(file);
      if (!c.ok) return reject(new Error(c.reason));
      if (file.type === 'application/pdf') return resolve(file);
      var url;
      try { url = URL.createObjectURL(file); } catch (e) { return reject(e); }
      var img = new Image();
      var done = function (fn, v) { try { URL.revokeObjectURL(url); } catch (e) { /* nothing to free */ } fn(v); };
      img.onload = function () {
        try {
          var scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
          var cv = w.document.createElement('canvas');
          cv.width = Math.max(1, Math.round(img.width * scale)); cv.height = Math.max(1, Math.round(img.height * scale));
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          cv.toBlob(function (b) { if (b) done(resolve, b); else done(reject, new Error('encode')); }, 'image/jpeg', 0.85);
        } catch (e) { done(reject, e); }
      };
      img.onerror = function () { done(reject, new Error('decode')); };
      img.src = url;
    });
  }

  /**
   * Upload files one by one. pathFor(i, base, ext) -> the Storage path (the caller
   * owns the folder). Resolves [{ path, name }]. Rejects on the first failure.
   */
  async function upload(files, pathFor) {
    if (!w.storage || !w.ref || !w.uploadBytes) throw new Error('storage unavailable');
    var out = [];
    var list = Array.prototype.slice.call(files || [], 0, MAX_FILES);
    for (var i = 0; i < list.length; i++) {
      var body = await prepare(list[i]);
      var pdf = (body.type || '') === 'application/pdf';
      var path = pathFor(i, safeBase(list[i].name), pdf ? 'pdf' : 'jpg');
      if (!pathOk(path)) throw new Error('bad proof path');
      await w.uploadBytes(w.ref(w.storage, path), body, { contentType: pdf ? 'application/pdf' : 'image/jpeg' });
      out.push({ path: path, name: String(list[i].name || 'proof').slice(0, 120) });
    }
    return out;
  }

  /** A hidden file input; cb(files[]) with what was picked. */
  function choose(cb) {
    var inp = w.document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*,application/pdf'; inp.multiple = true; inp.style.display = 'none';
    inp.addEventListener('change', function () { var fs = Array.prototype.slice.call(inp.files || []); inp.remove(); if (fs.length) cb(fs); });
    w.document.body.appendChild(inp);
    inp.click();
  }

  // The photo is fetched through the signed-in SDK (getBlob) and shown from a blob: URL,
  // the same way the call recordings are. Never a download URL: those carry a permanent
  // ?token= that works for anyone who has the link.
  async function sdk() {
    return w._nbdStorageSdk || (w._nbdStorageSdk = await import('/assets/vendor/firebase/10.12.2/firebase-storage.js'));
  }
  var blobUrls = {};
  async function urlFor(path) {
    if (!pathOk(path) || !w.storage) return '';
    if (blobUrls[path]) return blobUrls[path];
    try {
      var st = await sdk();
      var blob = await st.getBlob(st.ref(w.storage, path));
      return (blobUrls[path] = w.URL.createObjectURL(blob));
    } catch (e) { return ''; }
  }
  /** Open one proof in a new tab (a short-lived URL, never stored). */
  async function open(path) {
    var url = await urlFor(path);
    if (!url) { if (typeof w.showToast === 'function') w.showToast('Could not open that proof. Only the person who uploaded it can open it.', 'error'); return false; }
    w.open(url, '_blank', 'noopener');
    return true;
  }

  /** A strip of thumbnails; call hydrate(root) after the HTML is on the page. */
  function thumbsHtml(paths) {
    var ok = (paths || []).filter(pathOk);
    if (!ok.length) return '';
    return '<div class="pp-strip">' + ok.map(function (p) {
      return '<button type="button" class="pp-thumb" data-pp-open="' + esc(p) + '" aria-label="Open proof">' +
        (isPdfPath(p) ? '<span class="pp-pdf">PDF</span>' : '<img alt="" class="pp-img" data-pp-img="' + esc(p) + '">') + '</button>';
    }).join('') + '</div>';
  }
  /** Fill in the <img> thumbnails under rootEl (one short-lived URL per image). */
  function hydrate(rootEl) {
    if (!rootEl || !rootEl.querySelectorAll) return;
    Array.prototype.forEach.call(rootEl.querySelectorAll('img[data-pp-img]'), function (img) {
      if (img.getAttribute('src')) return;
      var p = img.getAttribute('data-pp-img');
      urlFor(p).then(function (u) { if (u) img.setAttribute('src', u); else img.parentNode && img.parentNode.classList.add('pp-missing'); });
    });
  }

  if (!w._NBD_PP_DELEGATE) {
    w._NBD_PP_DELEGATE = true;
    w.document.addEventListener('click', function (ev) {
      var t = ev.target && ev.target.closest && ev.target.closest('[data-pp-open]');
      if (t) open(t.getAttribute('data-pp-open'));
    });
  }

  API.prepare = prepare; API.upload = upload; API.choose = choose; API.open = open; API.urlFor = urlFor;
  API.thumbsHtml = thumbsHtml; API.hydrate = hydrate;
  w.NBDProofPhotos = API;
})(typeof window !== 'undefined' ? window : null);
