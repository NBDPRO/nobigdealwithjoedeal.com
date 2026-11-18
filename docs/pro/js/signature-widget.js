/*
 * NBD Signature Widget
 *
 * Self-contained, vanilla-JS canvas signature pad. Designed to run
 * INSIDE the sandboxed srcdoc iframe spun up by NBDDocViewer (no
 * `allow-same-origin`, so parent <-> iframe communication is strictly
 * via postMessage).
 *
 * Usage in a generated doc HTML:
 *   - Render one or more <div data-nbd-sig="role" data-required="true">
 *     blocks containing a <canvas class="nbd-sig-canvas">.
 *   - Include this file with a <script src="..."> before </body>.
 *   - It auto-initializes pads + listens for postMessage from the
 *     parent doc viewer.
 *
 * postMessage protocol (parent -> iframe):
 *   { __nbd_sig: 'status' }    -> iframe replies with state
 *   { __nbd_sig: 'finalize' }  -> iframe converts canvases to <img>,
 *                                 serializes documentElement.outerHTML,
 *                                 replies with finalized HTML
 *
 * Replies (iframe -> parent), echoed back through window.parent:
 *   { __nbd_sig: 'status', hasUnsigned: bool, required: [...],
 *     signers: [{role, signed, required}] }
 *   { __nbd_sig: 'finalized', ok: true,  html, signers: [{role, signedAt}] }
 *   { __nbd_sig: 'finalized', ok: false, missing: [...roles] }
 */
(function () {
  'use strict';
  const __NBD_LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
  if (__NBD_LOADED['signature-widget']) return;
  __NBD_LOADED['signature-widget'] = true;

  var pads = []; // [{block, canvas, pad, role, required}]
  // PR3b: role -> saved PNG dataURL, pushed in by the parent viewer via
  // postMessage({__nbd_sig:'savedSigs'}). When a block's role has a saved
  // sig, the widget offers a "Use saved" button that stamps it onto the
  // pad so the rep/customer can skip re-drawing.
  var savedSigs = {};

  function NBDSignaturePad(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.strokes = [];
    this.current = null;
    this.isEmpty = true;
    this._setupCanvas();
    this._bindEvents();
  }

  NBDSignaturePad.prototype._setupCanvas = function () {
    var dpr = window.devicePixelRatio || 1;
    var rect = this.canvas.getBoundingClientRect();
    // If the canvas has zero size (display:none or layout pending),
    // fall back to attribute sizing so we don't divide-by-zero later.
    var w = Math.max(rect.width, 1);
    var h = Math.max(rect.height, 1);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this._dpr = dpr;
    this._w = w;
    this._h = h;
    this.ctx.scale(dpr, dpr);
    this.ctx.lineWidth = 2;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.strokeStyle = '#12223D';
    // touch-action:none prevents the browser from scrolling while
    // the user is drawing on a phone. Critical for the rep handoff.
    this.canvas.style.touchAction = 'none';
  };

  NBDSignaturePad.prototype._bindEvents = function () {
    var self = this;
    this.canvas.addEventListener('pointerdown', function (e) { self._onDown(e); });
    this.canvas.addEventListener('pointermove', function (e) { self._onMove(e); });
    this.canvas.addEventListener('pointerup',   function (e) { self._onUp(e); });
    this.canvas.addEventListener('pointercancel', function (e) { self._onUp(e); });
    this.canvas.addEventListener('pointerleave',  function (e) { self._onUp(e); });
  };

  NBDSignaturePad.prototype._pos = function (e) {
    var rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  NBDSignaturePad.prototype._onDown = function (e) {
    e.preventDefault();
    try { this.canvas.setPointerCapture(e.pointerId); } catch (_) {}
    var p = this._pos(e);
    this.current = [p];
    this.ctx.beginPath();
    this.ctx.moveTo(p.x, p.y);
  };

  NBDSignaturePad.prototype._onMove = function (e) {
    if (!this.current) return;
    e.preventDefault();
    var p = this._pos(e);
    this.current.push(p);
    this.ctx.lineTo(p.x, p.y);
    this.ctx.stroke();
  };

  NBDSignaturePad.prototype._onUp = function (e) {
    if (!this.current) return;
    if (this.current.length > 1) {
      this.strokes.push(this.current);
      this.isEmpty = false;
    }
    this.current = null;
    this._notify();
  };

  NBDSignaturePad.prototype.clear = function () {
    this.ctx.clearRect(0, 0, this._w, this._h);
    this.strokes = [];
    this.isEmpty = true;
    this._notify();
  };

  NBDSignaturePad.prototype.undo = function () {
    this.strokes.pop();
    this.ctx.clearRect(0, 0, this._w, this._h);
    for (var i = 0; i < this.strokes.length; i++) {
      var s = this.strokes[i];
      if (s.length < 2) continue;
      this.ctx.beginPath();
      this.ctx.moveTo(s[0].x, s[0].y);
      for (var j = 1; j < s.length; j++) this.ctx.lineTo(s[j].x, s[j].y);
      this.ctx.stroke();
    }
    this.isEmpty = this.strokes.length === 0;
    this._notify();
  };

  NBDSignaturePad.prototype._notify = function () {
    try {
      var ev = new CustomEvent('nbd-sig-change', { detail: { isEmpty: this.isEmpty } });
      this.canvas.dispatchEvent(ev);
    } catch (_) {}
  };

  // Produce a clean PNG with a white background (PDFs and emails
  // render with white bg even if the canvas is transparent).
  NBDSignaturePad.prototype.toPNG = function () {
    if (this.isEmpty) return null;
    var out = document.createElement('canvas');
    out.width = this.canvas.width;
    out.height = this.canvas.height;
    var octx = out.getContext('2d');
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(this.canvas, 0, 0);
    return out.toDataURL('image/png');
  };

  // ── Finger-sized controls (2026-09-25, phone audit homeowner#3) ──
  // The pad's Clear / Undo buttons come from document-generator.js's
  // _injectSignatureAssets CSS: font-size 11px, padding 4px 10px — 48x22 and
  // 102x22 on a phone, the only way to redo a botched finger signature. A tap
  // 14px below Clear's centre landed on the block, not the button.
  //
  // Sized HERE rather than in that CSS because the generator's <style> is
  // part of the legal record (stored, printed, and rendered by the doc
  // viewer's html2pdf in the rep's own page, where a phone media query would
  // match). This sheet exists only while a pad is live and is cut back out
  // of the serialised HTML in finalize(), so the record is unchanged. It
  // covers every surface that loads the widget: remote signing (sign.html)
  // and the rep's in-person signing in the doc viewer.
  var TOUCH_STYLE_ID = 'nbd-sig-touch';
  var touchStyleEl = null;
  function ensureTouchStyle() {
    if (touchStyleEl || !document.head) return;
    touchStyleEl = document.createElement('style');
    touchStyleEl.id = TOUCH_STYLE_ID;
    touchStyleEl.textContent =
      '@media screen and (pointer:coarse),screen and (max-width:600px){' +
      '.nbd-sig-controls{gap:10px;flex-wrap:wrap;margin-top:8px;}' +
      '.nbd-sig-controls button{min-height:44px;padding:10px 16px;font-size:15px;border-radius:8px;border-color:#b8bec8;color:#1A3057;}' +
      '.nbd-sig-state{font-size:14px;}' +
      '}';
    document.head.appendChild(touchStyleEl);
  }

  function initBlock(block) {
    if (block.__nbdSigInit) return;
    if (block.getAttribute('data-nbd-sig-finalized') === '1') return;
    var canvas = block.querySelector('canvas.nbd-sig-canvas');
    if (!canvas) return;
    ensureTouchStyle();
    var pad = new NBDSignaturePad(canvas);
    var entry = {
      block: block,
      canvas: canvas,
      pad: pad,
      role: block.getAttribute('data-nbd-sig') || 'signer',
      label: block.getAttribute('data-label') || '',
      required: block.getAttribute('data-required') !== 'false',
    };
    pads.push(entry);
    block.__nbdSigInit = true;

    var clearBtn = block.querySelector('[data-nbd-sig-action="clear"]');
    var undoBtn  = block.querySelector('[data-nbd-sig-action="undo"]');
    if (clearBtn) clearBtn.addEventListener('click', function (e) { e.preventDefault(); pad.clear(); });
    if (undoBtn)  undoBtn.addEventListener('click',  function (e) { e.preventDefault(); pad.undo(); });

    canvas.addEventListener('nbd-sig-change', function () {
      // Update the local "signed" indicator without re-finalizing.
      var ind = block.querySelector('.nbd-sig-state');
      if (ind) ind.textContent = pad.isEmpty ? '' : '✓ signed';
    });
  }

  function initAll(root) {
    var scope = root || document;
    var blocks = scope.querySelectorAll('[data-nbd-sig]');
    for (var i = 0; i < blocks.length; i++) initBlock(blocks[i]);
    renderSavedButtons();
  }

  // PR3b: draw a saved signature PNG onto a pad's canvas so it behaves
  // exactly like a freshly-drawn sig — getStatus() sees it as signed and
  // finalize() re-exports it through the normal path. Re-rasterization is
  // 1:1 (same canvas box) so there's no visible quality loss.
  function applySavedToPad(entry, dataURL) {
    var img = new Image();
    img.onload = function () {
      entry.pad.clear(); // reset strokes + canvas first
      try { entry.pad.ctx.drawImage(img, 0, 0, entry.pad._w, entry.pad._h); } catch (_) { return; }
      entry.pad.isEmpty = false;
      entry.pad._notify();
      var ind = entry.block.querySelector('.nbd-sig-state');
      if (ind) ind.textContent = '✓ saved signature';
    };
    img.src = dataURL;
  }

  // Inject a "Use saved" button into each block whose role has a saved
  // signature (and isn't already finalized). Idempotent per block.
  function renderSavedButtons() {
    for (var i = 0; i < pads.length; i++) {
      var e = pads[i];
      if (e.__savedBtnDone) continue;
      if (e.block.getAttribute('data-nbd-sig-finalized') === '1') continue;
      var saved = savedSigs[e.role];
      if (!saved) continue;
      var controls = e.block.querySelector('.nbd-sig-controls');
      if (!controls) continue;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-nbd-sig-action', 'use-saved');
      btn.textContent = 'Use saved';
      controls.insertBefore(btn, controls.firstChild);
      e.__savedBtnDone = true;
      (function (entry, dataURL) {
        btn.addEventListener('click', function (ev) { ev.preventDefault(); applySavedToPad(entry, dataURL); });
      })(e, saved);
    }
  }

  function getStatus() {
    var signers = pads.map(function (e) {
      return {
        role: e.role,
        label: e.label,
        signed: !e.pad.isEmpty,
        required: e.required,
        finalized: e.block.getAttribute('data-nbd-sig-finalized') === '1',
      };
    });
    var missing = signers.filter(function (s) { return s.required && !s.signed && !s.finalized; });
    return {
      hasUnsigned: missing.length > 0,
      required: missing.map(function (s) { return s.role; }),
      signers: signers,
    };
  }

  // Tick controls (the attic acknowledgment, phase 3): <input data-nbd-ack="id" [data-nbd-required="1"]>. A required
  // checkbox must be ticked and every Yes/No line (radios sharing an id up to ":yes"/":no") needs one answer.
  function ackMissing() {
    var els = document.querySelectorAll('input[data-nbd-ack]');
    var groups = {}, miss = 0;
    for (var i = 0; i < els.length; i++) {
      var el = els[i], id = el.getAttribute('data-nbd-ack') || '';
      if (el.type === 'radio') {
        var g = id.replace(/:(yes|no)$/, '');
        groups[g] = groups[g] || el.checked;
      } else if (el.getAttribute('data-nbd-required') === '1' && !el.checked) miss++;
    }
    Object.keys(groups).forEach(function (g) { if (!groups[g]) miss++; });
    return miss;
  }
  // innerHTML does not carry a control's live state: write it into the markup so the saved copy shows what was ticked.
  function syncAcks() {
    var els = document.querySelectorAll('input[data-nbd-ack]');
    for (var i = 0; i < els.length; i++) {
      if (els[i].checked) els[i].setAttribute('checked', ''); else els[i].removeAttribute('checked');
      els[i].setAttribute('disabled', '');
    }
  }

  function finalize() {
    var status = getStatus();
    if (status.hasUnsigned) {
      return { ok: false, missing: status.required };
    }
    var ackLeft = ackMissing();
    if (ackLeft) {
      return { ok: false, missingAcks: ackLeft, missing: ['every tick box and a Yes or No on every line'] };
    }
    // A document with NO signature blocks used to finalize successfully:
    // getStatus() reported hasUnsigned:false over an empty pad list, so
    // this returned {ok:true, signers:[]}, the server burned the token and
    // stamped signedRemotely:true, and the rep was notified "Document
    // signed" — an executed-contract record containing zero signatures.
    // Only ONE of the 27 document types emits canvas blocks, so every
    // other type sent for signature produced exactly that.
    if (!pads.length) {
      return { ok: false, noFields: true, missing: [] };
    }
    // Same hole one level down: blocks that exist but are all optional and
    // all blank would capture nothing and still report success.
    var anySigned = pads.some(function (e) {
      return !e.pad.isEmpty || e.block.getAttribute('data-nbd-sig-finalized') === '1';
    });
    if (!anySigned) {
      return { ok: false, noSignature: true, missing: [] };
    }
    var dateStr = new Date().toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric'
    });
    var signedSigners = [];
    for (var i = 0; i < pads.length; i++) {
      var e = pads[i];
      if (e.block.getAttribute('data-nbd-sig-finalized') === '1') continue;
      if (e.pad.isEmpty) continue; // optional signer left blank
      var png = e.pad.toPNG();
      var img = document.createElement('img');
      img.src = png;
      img.alt = e.label || (e.role + ' signature');
      img.className = 'nbd-sig-img';
      // Inline-style so the embed survives even if our CSS is stripped
      // during PDF export (handlePdf removes <script>, but <style>
      // inside <head> is preserved).
      img.setAttribute('style', 'max-width:100%;height:auto;display:block;background:#fff;');
      if (e.canvas.parentNode) e.canvas.parentNode.replaceChild(img, e.canvas);

      // Replace the controls row with a signed-on stamp.
      var ctrl = e.block.querySelector('.nbd-sig-controls');
      if (ctrl) {
        var stamp = document.createElement('div');
        stamp.className = 'nbd-sig-date';
        stamp.textContent = 'Signed ' + dateStr;
        ctrl.parentNode.replaceChild(stamp, ctrl);
      }
      e.block.setAttribute('data-nbd-sig-finalized', '1');
      e.block.setAttribute('data-nbd-sig-signed-at', new Date().toISOString());
      // PR3a: include the captured PNG so the parent can persist it to
      // leads/{leadId}/signatures/{role} for reuse on future docs. The
      // dataURL is already baked into the finalized HTML <img> too; this
      // just hands it back out-of-band so the parent doesn't have to
      // re-parse the serialized HTML to recover each role's signature.
      signedSigners.push({ role: e.role, label: e.label || null, signedAt: new Date().toISOString(), png: png });
    }

    // Serialize the full document so the parent can re-upload to
    // Firebase Storage. documentElement covers <head> + <body> in one
    // string. Prepend the doctype so the saved HTML still parses
    // correctly when reopened.
    syncAcks();
    var html = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
    // The touch sheet is display chrome, not document: cut its exact
    // serialisation back out so the record matches what was sent.
    if (touchStyleEl) html = html.split(touchStyleEl.outerHTML).join('');
    return { ok: true, html: html, signers: signedSigners };
  }

  // ── postMessage bridge to parent doc viewer ───────────────
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || typeof d !== 'object' || !d.__nbd_sig) return;
    if (d.__nbd_sig === 'status') {
      var s = getStatus();
      s.__nbd_sig = 'status';
      try { (ev.source || window.parent).postMessage(s, '*'); } catch (_) {}
    } else if (d.__nbd_sig === 'finalize') {
      var r = finalize();
      r.__nbd_sig = 'finalized';
      try { (ev.source || window.parent).postMessage(r, '*'); } catch (_) {}
    } else if (d.__nbd_sig === 'savedSigs') {
      // Parent handed us this lead's previously-captured signatures
      // (role -> PNG dataURL). Offer a "Use saved" button per matching
      // block. May arrive before or after blocks init — both are handled
      // (initAll re-runs renderSavedButtons).
      if (d.sigs && typeof d.sigs === 'object') {
        savedSigs = d.sigs;
        renderSavedButtons();
      }
    }
  });

  // ── Auto-init on load. Re-scan on DOM additions for late inserts. ──
  function boot() { initAll(document); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  try {
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n && n.nodeType === 1) initAll(n);
        }
      }
    });
    mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
  } catch (_) {}

  // Surface a tiny API for in-doc callers (rare) and tests.
  const NBDSig = {
    initAll: initAll,
    getStatus: getStatus,
    finalize: finalize,
  };
})();
