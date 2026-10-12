/**
 * my-skin-encode-worker.js — re-encode one picture off the main thread
 * (My Skin bulk import, 2026-10). Same job as encode() in my-skin.js: decode,
 * scale so the long edge is at most spec.maxEdge, encode webp (jpeg where the
 * browser can't), sample 32x32 luminance stats, and make the 256 px thumbnail.
 * EXIF/GPS never survive: the picture is redrawn on a canvas.
 *
 * A same-origin classic worker (worker-src 'self'). It shares the pure maths
 * in my-skin-logic.js through importScripts. If this browser has no
 * OffscreenCanvas / createImageBitmap in workers it answers "unsupported" and
 * the caller falls back to the main thread; a picture the worker cannot
 * decode (HEIC off Safari) answers "decode" and the caller retries there.
 */
'use strict';
importScripts('my-skin-logic.js?v=6');
var L = self.NBDMySkinLogic;
var LIN = null;

function stats(canvas) {
  try {
    if (!LIN) { LIN = []; for (var i = 0; i < 256; i++) { var v = i / 255; LIN.push(v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)); } }
    var s = new OffscreenCanvas(32, 32);
    var x = s.getContext('2d'); x.drawImage(canvas, 0, 0, 32, 32);
    var d = x.getImageData(0, 0, 32, 32).data;
    var all = 0, ctr = 0, nAll = 0, nCtr = 0, r = 0, g = 0, b = 0;
    for (var py = 0; py < 32; py++) {
      for (var px = 0; px < 32; px++) {
        var o = (py * 32 + px) * 4;
        var l = 0.2126 * LIN[d[o]] + 0.7152 * LIN[d[o + 1]] + 0.0722 * LIN[d[o + 2]];
        all += l; nAll++; r += d[o]; g += d[o + 1]; b += d[o + 2];
        if (px >= 10 && px < 22 && py >= 10 && py < 22) { ctr += l; nCtr++; }
      }
    }
    var hex = function (n) { var h = Math.round(n / nAll).toString(16); return h.length < 2 ? '0' + h : h; };
    return { lum: all / nAll, lumCenter: ctr / nCtr, avg: '#' + hex(r) + hex(g) + hex(b), accent: L.accentFromSample(d) };
  } catch (e) { return null; }
}

function render(bmp, sw, sh, type, q, maxEdge) {
  var d = L.fitWithin(sw, sh, maxEdge);
  var c = new OffscreenCanvas(d.w, d.h);
  var x = c.getContext('2d');
  if (type === 'image/jpeg') { x.fillStyle = '#000'; x.fillRect(0, 0, d.w, d.h); }
  x.drawImage(bmp, 0, 0, d.w, d.h);
  return c.convertToBlob(q == null ? { type: type } : { type: type, quality: q })
    .then(function (b) { return { blob: b, canvas: c, w: d.w, h: d.h }; });
}

function thumb(canvas) {
  var tw = Math.min(L.THUMB_WIDTH, canvas.width), th = Math.max(1, Math.round(canvas.height * tw / canvas.width));
  var c = new OffscreenCanvas(tw, th);
  c.getContext('2d').drawImage(canvas, 0, 0, tw, th);
  return c.convertToBlob({ type: 'image/webp', quality: 0.7 }).then(function (b) {
    return b.type === 'image/webp' ? b : c.convertToBlob({ type: 'image/jpeg', quality: 0.78 });
  });
}

function encode(file, spec, wantThumb) {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') return Promise.reject(new Error('unsupported'));
  var maxBytes = spec.maxBytes || L.MAX_STORED_BYTES;
  return createImageBitmap(file).then(function (bmp) {
    var sw = bmp.width, sh = bmp.height;
    function attempt(maxEdge, q, fq) {
      return render(bmp, sw, sh, spec.type, q, maxEdge).then(function (o) {
        if (o.blob && o.blob.type === spec.type) return o;
        if (spec.fallbackType) return render(bmp, sw, sh, spec.fallbackType, fq, maxEdge);
        return o;
      });
    }
    return attempt(spec.maxEdge, spec.quality, spec.fallbackQuality).then(function (o) {
      if (o.blob && o.blob.size < maxBytes) return o;
      return attempt(Math.round(spec.maxEdge * 0.7), 0.72, 0.72);
    }).then(function (o) {
      try { bmp.close(); } catch (e) {}
      if (!o.blob || o.blob.size >= maxBytes) throw new Error('too-big');
      var res = { blob: o.blob, w: o.w, h: o.h, srcW: sw, srcH: sh, stats: stats(o.canvas), thumb: null };
      if (!wantThumb) return res;
      return thumb(o.canvas).then(function (t) { res.thumb = t; return res; }, function () { return res; });
    });
  }, function () { throw new Error('decode'); });
}

self.onmessage = function (e) {
  var m = e.data || {};
  encode(m.file, m.spec, !!m.thumb).then(function (r) {
    self.postMessage({ id: m.id, ok: true, blob: r.blob, w: r.w, h: r.h, srcW: r.srcW, srcH: r.srcH, stats: r.stats, thumb: r.thumb });
  }, function (err) {
    self.postMessage({ id: m.id, ok: false, error: String(err && err.message || err) });
  });
};
