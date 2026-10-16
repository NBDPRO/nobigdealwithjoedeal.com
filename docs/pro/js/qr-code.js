/**
 * qr-code.js — a small QR code encoder that runs in the page (2026-10-16).
 *
 * Why it exists: the "Job done" review hand-off (review-handoff.js) shows the
 * homeowner a big QR code for the company's Google review page. The CSP blocks
 * CDNs and third-party image URLs, and a QR made by a web service would also
 * hand that service the link, so the code is drawn here, in the browser, as an
 * inline SVG. Nothing is fetched.
 *
 * What it does: byte mode (UTF-8), error correction M by default (Q / H / L on
 * request), versions 1 to 10 (up to 213 bytes at M: plenty for a review link),
 * the eight standard masks scored by the four standard penalty rules. The
 * structure follows ISO/IEC 18004 and Project Nayuki's reference generator.
 * tests/review-handoff-2026-10-16.test.js decodes the output with its own
 * reader (format bits, unmask, de-interleave, Reed-Solomon check) to prove it.
 *
 * API: NBDQr.encode(text, { ecl: 'M' }) -> { size, version, ecl, mask, modules: boolean[][] }
 *      NBDQr.svg(text, { ecl, border: 4 }) -> '<svg ...>' (dark on white, always:
 *      a phone camera needs the light quiet zone even in dark mode)
 */
(function (root) {
  'use strict';

  var ECL = { L: { ord: 0, fmt: 1 }, M: { ord: 1, fmt: 0 }, Q: { ord: 2, fmt: 3 }, H: { ord: 3, fmt: 2 } };
  var MAX_VERSION = 10;
  // [ecl ordinal][version], index 0 unused (ISO/IEC 18004 table 9).
  var ECC_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
  ];
  var NUM_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
  ];

  function rawDataModules(ver) {
    var r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var n = Math.floor(ver / 7) + 2;
      r -= (25 * n - 10) * n - 55;
      if (ver >= 7) r -= 36;
    }
    return r;
  }
  function dataCodewords(ver, e) {
    return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[e.ord][ver] * NUM_BLOCKS[e.ord][ver];
  }
  function alignPositions(ver, size) {
    if (ver === 1) return [];
    var n = Math.floor(ver / 7) + 2;
    var step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    var out = [];
    for (var pos = size - 7; out.length < n - 1; pos -= step) out.unshift(pos);
    out.unshift(6);
    return out;
  }

  // ── GF(256) / Reed-Solomon (poly 0x11D) ──────────────────────────────────
  function gfMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }
  function rsDivisor(degree) {
    var res = [];
    for (var i = 0; i < degree - 1; i++) res.push(0);
    res.push(1);
    var r = 1;
    for (var k = 0; k < degree; k++) {
      for (var j = 0; j < res.length; j++) {
        res[j] = gfMul(res[j], r);
        if (j + 1 < res.length) res[j] ^= res[j + 1];
      }
      r = gfMul(r, 0x02);
    }
    return res;
  }
  function rsRemainder(data, div) {
    var res = div.map(function () { return 0; });
    data.forEach(function (b) {
      var f = b ^ res.shift();
      res.push(0);
      div.forEach(function (c, i) { res[i] ^= gfMul(c, f); });
    });
    return res;
  }

  function utf8Bytes(s) {
    var out = [];
    var str = String(s == null ? '' : s);
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
        var d = str.charCodeAt(i + 1);
        if (d >= 0xDC00 && d <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00); i++; }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function Matrix(ver) {
    this.ver = ver;
    this.size = ver * 4 + 17;
    this.m = [];
    this.f = [];
    for (var y = 0; y < this.size; y++) {
      this.m.push(new Array(this.size).fill(false));
      this.f.push(new Array(this.size).fill(false));
    }
  }
  Matrix.prototype.set = function (x, y, dark) { this.m[y][x] = !!dark; this.f[y][x] = true; };

  function drawFunctionPatterns(M, e) {
    var size = M.size, i, j;
    for (i = 0; i < size; i++) { M.set(6, i, i % 2 === 0); M.set(i, 6, i % 2 === 0); }
    [[3, 3], [size - 4, 3], [3, size - 4]].forEach(function (c) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var d = Math.max(Math.abs(dx), Math.abs(dy)), xx = c[0] + dx, yy = c[1] + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) M.set(xx, yy, d !== 2 && d !== 4);
      }
    });
    var ap = alignPositions(M.ver, size), n = ap.length;
    for (i = 0; i < n; i++) for (j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (var ay = -2; ay <= 2; ay++) for (var ax = -2; ax <= 2; ax++) M.set(ap[i] + ax, ap[j] + ay, Math.max(Math.abs(ax), Math.abs(ay)) !== 1);
    }
    drawFormat(M, e, 0);
    drawVersion(M);
  }
  function bit(x, i) { return ((x >>> i) & 1) !== 0; }
  function drawFormat(M, e, mask) {
    var data = (e.fmt << 3) | mask, rem = data, i;
    for (i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412, size = M.size;
    for (i = 0; i <= 5; i++) M.set(8, i, bit(bits, i));
    M.set(8, 7, bit(bits, 6)); M.set(8, 8, bit(bits, 7)); M.set(7, 8, bit(bits, 8));
    for (i = 9; i < 15; i++) M.set(14 - i, 8, bit(bits, i));
    for (i = 0; i < 8; i++) M.set(size - 1 - i, 8, bit(bits, i));
    for (i = 8; i < 15; i++) M.set(8, size - 15 + i, bit(bits, i));
    M.set(8, size - 8, true);
  }
  function drawVersion(M) {
    if (M.ver < 7) return;
    var rem = M.ver, i;
    for (i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    var bits = (M.ver << 12) | rem;
    for (i = 0; i < 18; i++) {
      var b = bit(bits, i), a = M.size - 11 + (i % 3), c = Math.floor(i / 3);
      M.set(a, c, b); M.set(c, a, b);
    }
  }
  function drawCodewords(M, cw) {
    var i = 0, size = M.size;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var v = 0; v < size; v++) for (var j = 0; j < 2; j++) {
        var x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - v : v;
        if (!M.f[y][x] && i < cw.length * 8) { M.m[y][x] = bit(cw[i >>> 3], 7 - (i & 7)); i++; }
      }
    }
  }
  function maskHit(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return (x * y) % 2 + (x * y) % 3 === 0;
      case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
      default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    }
  }
  function applyMask(M, mask) {
    for (var y = 0; y < M.size; y++) for (var x = 0; x < M.size; x++) {
      if (!M.f[y][x] && maskHit(mask, x, y)) M.m[y][x] = !M.m[y][x];
    }
  }
  function penalty(M) {
    var size = M.size, m = M.m, p = 0, x, y, dark = 0;
    var line = function (get) {
      var run = 1, prev = get(0), s = 0, seq = [get(0)];
      for (var i = 1; i < size; i++) {
        var c = get(i);
        seq.push(c);
        if (c === prev) { run++; if (run === 5) s += 3; else if (run > 5) s += 1; }
        else { run = 1; prev = c; }
      }
      // finder-like 1011101 with four light modules on either side (light outside the symbol counts)
      var at = function (k) { return k >= 0 && k < size ? seq[k] : false; };
      for (var k = -4; k < size; k++) {
        var core = at(k) && !at(k + 1) && at(k + 2) && at(k + 3) && at(k + 4) && !at(k + 5) && at(k + 6);
        if (!core) continue;
        var before = !at(k - 1) && !at(k - 2) && !at(k - 3) && !at(k - 4);
        var after = !at(k + 7) && !at(k + 8) && !at(k + 9) && !at(k + 10);
        if (before) s += 40;
        if (after) s += 40;
      }
      return s;
    };
    for (y = 0; y < size; y++) p += line(function (i) { return m[y][i]; });
    for (x = 0; x < size; x++) p += line(function (i) { return m[i][x]; });
    for (y = 0; y < size - 1; y++) for (x = 0; x < size - 1; x++) {
      var c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
    }
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (m[y][x]) dark++;
    var total = size * size;
    var k2 = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return p + Math.max(0, k2) * 10;
  }

  function encode(text, opts) {
    var o = opts || {};
    var e = ECL[String(o.ecl || 'M').toUpperCase()] || ECL.M;
    var bytes = utf8Bytes(text);
    var ver = 0;
    for (var v = 1; v <= MAX_VERSION; v++) {
      var cc = v < 10 ? 8 : 16;
      if (4 + cc + bytes.length * 8 <= dataCodewords(v, e) * 8) { ver = v; break; }
    }
    if (!ver) throw new Error('qr_too_long');
    var cap = dataCodewords(ver, e) * 8;
    var bits = [];
    var push = function (val, n) { for (var i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    push(4, 4);
    push(bytes.length, ver < 10 ? 8 : 16);
    bytes.forEach(function (b) { push(b, 8); });
    push(0, Math.min(4, cap - bits.length));
    push(0, (8 - (bits.length % 8)) % 8);
    var data = [];
    for (var i = 0; i < bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      data.push(b);
    }
    for (var pad = 0xEC; data.length < cap / 8; pad ^= 0xEC ^ 0x11) data.push(pad);

    // error correction blocks + interleave
    var nb = NUM_BLOCKS[e.ord][ver], eccLen = ECC_PER_BLOCK[e.ord][ver];
    var raw = Math.floor(rawDataModules(ver) / 8);
    var nShort = nb - (raw % nb), shortLen = Math.floor(raw / nb);
    var div = rsDivisor(eccLen), blocks = [], k = 0;
    for (var bi = 0; bi < nb; bi++) {
      var dat = data.slice(k, k + shortLen - eccLen + (bi < nShort ? 0 : 1));
      k += dat.length;
      var ecc = rsRemainder(dat, div);
      if (bi < nShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    var cw = [];
    for (var ci = 0; ci < blocks[0].length; ci++) {
      for (var bj = 0; bj < blocks.length; bj++) {
        if (ci !== shortLen - eccLen || bj >= nShort) cw.push(blocks[bj][ci]);
      }
    }

    var M = new Matrix(ver);
    drawFunctionPatterns(M, e);
    drawCodewords(M, cw);
    var best = 0, bestScore = Infinity;
    for (var mk = 0; mk < 8; mk++) {
      applyMask(M, mk);
      drawFormat(M, e, mk);
      var sc = penalty(M);
      if (sc < bestScore) { bestScore = sc; best = mk; }
      applyMask(M, mk);
    }
    applyMask(M, best);
    drawFormat(M, e, best);
    return { size: M.size, version: ver, ecl: String(o.ecl || 'M').toUpperCase() in ECL ? String(o.ecl || 'M').toUpperCase() : 'M', mask: best, modules: M.m };
  }

  /** The QR as an SVG string: one path, dark on white, a 4-module quiet zone. */
  function svg(text, opts) {
    var o = opts || {};
    var q = encode(text, o);
    var border = Math.max(0, Math.floor(o.border == null ? 4 : o.border));
    var dim = q.size + border * 2, d = '';
    for (var y = 0; y < q.size; y++) for (var x = 0; x < q.size; x++) {
      if (q.modules[y][x]) d += 'M' + (x + border) + ',' + (y + border) + 'h1v1h-1z';
    }
    var label = String(o.label || 'QR code').replace(/[&<>"']/g, '');
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges" role="img" aria-label="' + label + '">' +
      '<rect width="' + dim + '" height="' + dim + '" fill="#FFFFFF"/><path d="' + d + '" fill="#000000"/></svg>';
  }

  var api = { encode: encode, svg: svg, _utf8: utf8Bytes, MAX_VERSION: MAX_VERSION };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDQr = api;
})(typeof window !== 'undefined' ? window : null);
