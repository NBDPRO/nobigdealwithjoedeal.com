/**
 * game-sprite.js — the game card's 32×32 pixel avatar (Jo, 2026-10-03:
 * "twice as detailed or more but super cute").
 *
 * Chibi proportions (big head, big shiny eyes, rosy cheeks, small body).
 * Every part is drawn into a 32×32 grid, then a 1-px outline is traced
 * around whatever was filled, so any combination comes out clean.
 *
 *   NBDSprite.OPTIONS      — the pickable parts (value lists + labels)
 *   NBDSprite.DEFAULTS     — a starting avatar
 *   NBDSprite.normalize(a) — any saved avatar → a valid one (old 16-px
 *                            saves map over; unknown values fall back)
 *   NBDSprite.draw(canvas, avatar)
 *
 * Pure drawing, no DOM writes besides the canvas. CSP-safe.
 */
(function () {
  'use strict';
  if (window.NBDSprite) return;

  var C = {
    skin: ['#FBD9C0', '#F2C6A0', '#D99A6C', '#B97A4E', '#8D5A36', '#5E3B23'],
    hair: ['#2C2420', '#5A3A22', '#A0612B', '#E0B45A', '#C2452D', '#9AA0A6'],
    color: ['#F2A900', '#378ADD', '#E24B4A', '#639922', '#F5F5F0', '#2C2C2A'],   // headwear
    shirt: ['#185FA5', '#D85A30', '#5F5E5A', '#0F6E56', '#7F4FB0', '#E8E4DA'],
    pants: ['#2E3A59', '#5C4A32', '#3D3D3A', '#6B7B8C'],
  };
  var OPTIONS = {
    skin:   { label: 'Skin', colors: C.skin },
    hair:   { label: 'Hair', values: [['short', 'Short'], ['spiky', 'Spiky'], ['long', 'Long'], ['buzz', 'Buzz'], ['ponytail', 'Ponytail'], ['bald', 'Bald']] },
    hairColor: { label: 'Hair color', colors: C.hair },
    eyes:   { label: 'Eyes', values: [['round', 'Bright'], ['happy', 'Happy'], ['wink', 'Wink'], ['sleepy', 'Chill']] },
    hat:    { label: 'Headwear', values: [['hardhat', 'Hard hat'], ['cap', 'Ball cap'], ['beanie', 'Beanie'], ['none', 'None']] },
    hatColor: { label: 'Headwear color', colors: C.color },
    beard:  { label: 'Beard', values: [['none', 'None'], ['stubble', 'Stubble'], ['mustache', 'Mustache'], ['full', 'Full']] },
    shirt:  { label: 'Shirt', colors: C.shirt },
    vest:   { label: 'Hi-vis vest', values: [['none', 'No'], ['yes', 'Yes']] },
    pants:  { label: 'Pants', colors: C.pants },
    tool:   { label: 'Tool', values: [['hammer', 'Hammer'], ['tape', 'Tape'], ['ladder', 'Ladder'], ['none', 'None']] },
    extra:  { label: 'Extras', values: [['none', 'None'], ['glasses', 'Safety glasses'], ['shades', 'Shades'], ['belt', 'Tool belt']] },
  };
  var DEFAULTS = { skin: 1, hair: 'short', hairColor: 1, eyes: 'round', hat: 'hardhat', hatColor: 0, beard: 'none', shirt: 0, vest: 'none', pants: 0, tool: 'hammer', extra: 'none' };

  function pick(list, v, d) { return list.indexOf(v) >= 0 ? v : d; }
  function idx(n, len, d) { n = Number(n); return Number.isInteger(n) && n >= 0 && n < len ? n : d; }
  function normalize(a) {
    a = a || {};
    var vals = function (k) { return OPTIONS[k].values.map(function (v) { return v[0]; }); };
    // The first (16-px) card saved { skin 0–3, hat 0–3 (colour), shirt 0–3, tool }.
    var hatColor = a.hatColor != null ? a.hatColor : (typeof a.hat === 'number' ? a.hat : DEFAULTS.hatColor);
    return {
      skin: idx(a.skin, C.skin.length, DEFAULTS.skin),
      hair: pick(vals('hair'), a.hair, DEFAULTS.hair),
      hairColor: idx(a.hairColor, C.hair.length, DEFAULTS.hairColor),
      eyes: pick(vals('eyes'), a.eyes, DEFAULTS.eyes),
      hat: pick(vals('hat'), typeof a.hat === 'number' ? 'hardhat' : a.hat, DEFAULTS.hat),
      hatColor: idx(hatColor, C.color.length, DEFAULTS.hatColor),
      beard: pick(vals('beard'), a.beard, DEFAULTS.beard),
      shirt: idx(a.shirt, C.shirt.length, DEFAULTS.shirt),
      vest: pick(vals('vest'), a.vest, DEFAULTS.vest),
      pants: idx(a.pants, C.pants.length, DEFAULTS.pants),
      tool: pick(vals('tool'), a.tool, DEFAULTS.tool),
      extra: pick(vals('extra'), a.extra, DEFAULTS.extra),
    };
  }

  // Slightly darker / lighter shade of a hex colour (for shading).
  function shade(hex, amt) {
    var n = parseInt(hex.slice(1), 16);
    var r = Math.max(0, Math.min(255, (n >> 16) + amt)), g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt)), b = Math.max(0, Math.min(255, (n & 255) + amt));
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  function build(a) {
    var G = [];
    for (var i = 0; i < 32; i++) G.push(new Array(32).fill(null));
    var set = function (x, y, c) { if (x >= 0 && x < 32 && y >= 0 && y < 32) G[y][x] = c; };
    var rect = function (x0, y0, x1, y1, c) { for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) set(x, y, c); };
    var row = function (y, x0, x1, c) { rect(x0, y, x1, y, c); };

    var skin = C.skin[a.skin], skinD = shade(skin, -28);
    var hair = C.hair[a.hairColor], hairD = shade(hair, -30), hairL = shade(hair, 30);
    var hatC = C.color[a.hatColor], hatD = shade(hatC, -40), hatL = shade(hatC, 35);
    var shirt = C.shirt[a.shirt], shirtD = shade(shirt, -35);
    var pants = C.pants[a.pants], pantsD = shade(pants, -25);
    var ink = '#2A2320', white = '#FFFFFF', blush = '#F29A9A';

    // ── body (drawn first; the head overlaps the neck) ──
    rect(14, 21, 17, 22, skinD);                       // neck
    rect(11, 22, 20, 27, shirt);                       // torso
    rect(11, 26, 20, 27, shirtD);                      // shirt shadow
    rect(9, 23, 10, 26, shirt); rect(21, 23, 22, 26, shirt);   // sleeves
    rect(9, 27, 10, 27, skin); rect(21, 27, 22, 27, skin);     // hands
    if (a.vest === 'yes') {
      var vest = '#C6E11C', vestD = '#9DB51A';
      rect(11, 22, 13, 27, vest); rect(18, 22, 20, 27, vest);
      row(25, 11, 13, '#D7D7D7'); row(25, 18, 20, '#D7D7D7');
      rect(13, 26, 13, 27, vestD); rect(18, 26, 18, 27, vestD);
    }
    if (a.extra === 'belt') {
      row(27, 11, 20, '#7A4A22'); set(15, 27, '#E0B45A'); set(16, 27, '#E0B45A');
      set(12, 28, '#9AA0A6'); set(19, 28, '#7A4A22');
    }
    rect(12, 28, 14, 29, pants); rect(17, 28, 19, 29, pants);  // legs
    set(14, 29, pantsD); set(17, 29, pantsD);
    rect(11, 30, 14, 30, '#4A3424'); rect(17, 30, 20, 30, '#4A3424'); // boots

    // ── head ──
    row(6, 10, 21, skin); row(7, 9, 22, skin);
    rect(8, 8, 23, 18, skin);
    row(19, 9, 22, skin); row(20, 10, 21, skin);
    row(20, 11, 20, skinD);                            // jaw shade
    rect(7, 12, 7, 14, skin); rect(24, 12, 24, 14, skin);         // ears
    set(7, 13, skinD); set(24, 13, skinD);

    // ── hair ──
    var top = function () { row(4, 11, 20, hair); row(5, 9, 22, hair); rect(8, 6, 23, 8, hair); set(12, 4, hairL); set(13, 5, hairL); };
    if (a.hair === 'short') { top(); rect(8, 9, 8, 11, hair); rect(23, 9, 23, 11, hair); row(9, 9, 11, hair); row(9, 20, 22, hair); set(14, 9, hairD); }
    else if (a.hair === 'spiky') {
      top();
      // Spikes only when nothing is on the head — a hat flattens them.
      if (a.hat === 'none') [10, 13, 16, 19].forEach(function (x) { set(x, 3, hair); set(x + 1, 2, hair); set(x + 1, 3, hair); });
      rect(8, 9, 8, 10, hair); rect(23, 9, 23, 10, hair);
    }
    else if (a.hair === 'long') { top(); rect(7, 8, 8, 19, hair); rect(23, 8, 24, 19, hair); rect(7, 18, 8, 19, hairD); rect(23, 18, 24, 19, hairD); row(9, 9, 13, hair); }
    else if (a.hair === 'buzz') { row(5, 11, 20, hairD); rect(9, 6, 22, 7, hairD); }
    else if (a.hair === 'ponytail') { top(); rect(8, 9, 8, 11, hair); rect(23, 9, 23, 11, hair); rect(24, 6, 26, 8, hair); rect(25, 9, 26, 13, hair); set(26, 14, hairD); set(24, 6, hairL); }
    // bald: nothing

    // ── headwear ──
    if (a.hat === 'hardhat') {
      row(2, 12, 19, hatC); row(3, 10, 21, hatC); rect(9, 4, 22, 7, hatC);
      rect(15, 2, 16, 7, hatL);                        // ridge
      row(8, 6, 25, hatD); row(7, 7, 24, hatC);        // brim
      set(11, 4, hatL); set(12, 3, hatL);
    } else if (a.hat === 'cap') {
      row(3, 11, 20, hatC); row(4, 9, 22, hatC); rect(8, 5, 23, 8, hatC);
      row(8, 8, 27, hatD); row(9, 21, 28, hatD);       // bill to the right
      set(15, 3, hatL); set(16, 3, hatL); set(15, 5, '#FFFFFF'); set(16, 5, '#FFFFFF');
    } else if (a.hat === 'beanie') {
      set(15, 1, hatL); set(16, 1, hatL); rect(14, 2, 17, 2, hatC);
      row(3, 11, 20, hatC); row(4, 9, 22, hatC); rect(8, 5, 23, 7, hatC);
      rect(8, 8, 23, 9, hatD); for (var bx = 9; bx <= 22; bx += 2) set(bx, 8, hatC);
    }

    // ── face ──
    var eyeL = 11, eyeR = 19, ey = 13;
    var roundEye = function (x) { rect(x, ey, x + 1, ey + 2, ink); set(x, ey, white); set(x + 1, ey + 2, '#5A4A44'); };
    var happyEye = function (x) { set(x - 1, ey + 2, ink); set(x, ey + 1, ink); set(x + 1, ey + 1, ink); set(x + 2, ey + 2, ink); };
    if (a.eyes === 'round') { roundEye(eyeL); roundEye(eyeR); }
    else if (a.eyes === 'happy') { happyEye(eyeL); happyEye(eyeR); }
    else if (a.eyes === 'wink') { roundEye(eyeL); row(ey + 2, eyeR - 1, eyeR + 2, ink); }
    else if (a.eyes === 'sleepy') { row(ey + 1, eyeL - 1, eyeL + 2, ink); row(ey + 1, eyeR - 1, eyeR + 2, ink); set(eyeL, ey + 2, ink); set(eyeR + 1, ey + 2, ink); }
    // brows
    row(11, eyeL - 1, eyeL + 1, a.hair === 'bald' ? skinD : hairD); row(11, eyeR, eyeR + 2, a.hair === 'bald' ? skinD : hairD);
    // cheeks + mouth
    set(9, 16, blush); set(10, 16, blush); set(21, 16, blush); set(22, 16, blush);
    set(14, 17, ink); set(15, 18, ink); set(16, 18, ink); set(17, 17, ink);
    // beard
    if (a.beard === 'stubble') { for (var sx = 10; sx <= 21; sx += 2) { set(sx, 19, hairD); set(sx + 1, 20, hairD); } }
    else if (a.beard === 'mustache') { row(17, 13, 18, hair); set(12, 18, hair); set(19, 18, hair); set(15, 18, ink); set(16, 18, ink); }
    else if (a.beard === 'full') { rect(8, 16, 9, 19, hair); rect(22, 16, 23, 19, hair); row(19, 9, 22, hair); row(20, 10, 21, hair); row(21, 12, 19, hairD); row(17, 13, 18, hair); set(15, 18, ink); set(16, 18, ink); }
    // eyewear
    if (a.extra === 'glasses') {
      var gl = '#9CD3F0';
      rect(eyeL - 1, ey - 1, eyeL + 2, ey + 3, gl); rect(eyeR - 1, ey - 1, eyeR + 2, ey + 3, gl);
      row(ey, eyeL + 3, eyeR - 2, '#6B7B8C'); set(8, ey, '#6B7B8C'); set(23, ey, '#6B7B8C');
      if (a.eyes === 'round') { roundEye(eyeL); roundEye(eyeR); } else if (a.eyes === 'wink') { roundEye(eyeL); row(ey + 2, eyeR - 1, eyeR + 2, ink); }
      else if (a.eyes === 'happy') { happyEye(eyeL); happyEye(eyeR); } else { row(ey + 1, eyeL - 1, eyeL + 2, ink); row(ey + 1, eyeR - 1, eyeR + 2, ink); }
    } else if (a.extra === 'shades') {
      rect(eyeL - 1, ey, eyeL + 2, ey + 2, ink); rect(eyeR - 1, ey, eyeR + 2, ey + 2, ink);
      row(ey, eyeL + 3, eyeR - 2, ink); set(eyeL - 1, ey, '#6B7B8C'); set(eyeR - 1, ey, '#6B7B8C');
    }

    // ── tool, held at the right hand ──
    if (a.tool === 'hammer') {
      rect(24, 20, 24, 28, '#8B5A2B'); set(24, 28, '#6B4423');
      rect(22, 18, 26, 19, '#8A8F96'); set(26, 19, '#5F6368'); set(22, 18, '#B4B8BD');
      set(23, 27, skin);
    } else if (a.tool === 'tape') {
      rect(23, 24, 27, 28, '#F2C200'); rect(24, 25, 26, 27, '#2C2C2A'); set(25, 26, '#F2C200');
      row(28, 27, 30, '#E8E4DA'); set(23, 27, skin);
    } else if (a.tool === 'ladder') {
      for (var ly = 10; ly <= 30; ly++) { set(25, ly, '#B4B2A9'); set(29, ly, '#B4B2A9'); }
      for (var ry = 12; ry <= 30; ry += 3) row(ry, 26, 28, '#8F8D86');
    }
    return G;
  }

  // Trace a 1-px outline around every filled pixel (the "cute" part).
  function outline(G) {
    var out = G.map(function (r) { return r.slice(); });
    var line = '#2A2320';
    for (var y = 0; y < 32; y++) for (var x = 0; x < 32; x++) {
      if (G[y][x]) continue;
      var n = (y > 0 && G[y - 1][x]) || (y < 31 && G[y + 1][x]) || (x > 0 && G[y][x - 1]) || (x < 31 && G[y][x + 1]);
      if (n) out[y][x] = line;
    }
    return out;
  }

  function draw(canvas, avatar) {
    if (!canvas || !canvas.getContext) return;
    var a = normalize(avatar);
    var G = outline(build(a));
    var g = canvas.getContext('2d');
    var u = canvas.width / 32;
    g.clearRect(0, 0, canvas.width, canvas.height);
    for (var y = 0; y < 32; y++) for (var x = 0; x < 32; x++) {
      if (!G[y][x]) continue;
      g.fillStyle = G[y][x];
      g.fillRect(x * u, y * u, u, u);
    }
  }

  window.NBDSprite = { OPTIONS: OPTIONS, DEFAULTS: DEFAULTS, normalize: normalize, draw: draw, _build: build, _outline: outline };
})();
