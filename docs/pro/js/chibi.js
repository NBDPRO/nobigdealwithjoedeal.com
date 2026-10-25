/**
 * chibi.js — the NBD Pro character renderer (2026-10-25, Jo: "make the characters, sprites and animations as high
 * quality as we can").
 *
 * One vector chibi, drawn with Canvas 2D paths at any size: a big round head with soft shading and a highlight, big
 * shiny eyes that blink, rosy cheeks, a small body, a clean dark outline around every part (the "sticker" look), and
 * eight animated poses. It replaces the 32×32 pixel grid on the Roof Rep street, in the speech sheet, the locker, the
 * HUD and the tutorial, and on the CRM game card. The parts and palette are the same ones the pixel sprite used, so
 * every saved avatar renders as the same person, just drawn properly.
 *
 *   NBDChibi.draw(ctx, look, o)        — draw into any 2D context. o: { x, y: feet centre, h: height in px,
 *                                         t: ms, pose, facing: 1|-1, shadow: true, mood, blink: true }
 *   NBDChibi.paintCanvas(canvas, look, o) — size the bitmap to the canvas's CSS box × devicePixelRatio and draw the
 *                                         character to fit (used for every avatar canvas on the pages)
 *   NBDChibi.animate(canvas, look, fn) — a requestAnimationFrame loop (fn(t) returns the options per frame); returns
 *                                         stop(). Under prefers-reduced-motion it draws one still frame.
 *   NBDChibi.POSES                     — idle · walk · knock · talk · cheer · sad · wave · think
 *
 * Pure drawing; no DOM writes besides the canvas it is handed. CSP-safe, no dependencies. ES5 on purpose (classic
 * script on both pages). Guarded by tests/chibi-2026-10-25.test.js.
 */
(function () {
  'use strict';
  if (window.NBDChibi) return;

  var C = {
    skin: ['#FBD9C0', '#F2C6A0', '#D99A6C', '#B97A4E', '#8D5A36', '#5E3B23'],
    hair: ['#2C2420', '#5A3A22', '#A0612B', '#E0B45A', '#C2452D', '#9AA0A6'],
    color: ['#F2A900', '#378ADD', '#E24B4A', '#639922', '#F5F5F0', '#2C2C2A'],
    shirt: ['#185FA5', '#D85A30', '#5F5E5A', '#0F6E56', '#7F4FB0', '#E8E4DA'],
    pants: ['#2E3A59', '#5C4A32', '#3D3D3A', '#6B7B8C'],
  };
  var HAIRS = ['short', 'spiky', 'long', 'buzz', 'ponytail', 'bald'], EYES = ['round', 'happy', 'wink', 'sleepy'];
  var HATS = ['hardhat', 'cap', 'beanie', 'none'], BEARDS = ['none', 'stubble', 'mustache', 'full'];
  var TOOLS = ['hammer', 'tape', 'ladder', 'none'], EXTRAS = ['none', 'glasses', 'shades', 'belt'];
  var POSES = ['idle', 'walk', 'knock', 'talk', 'cheer', 'sad', 'wave', 'think'];
  var INK = '#1f1a17', WHITE = '#FFFFFF', BLUSH = 'rgba(242,120,120,.45)', VEST = '#C6E11C', VESTD = '#9DB51A';
  var reduce = false;
  try { reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) {}

  function idx(n, len, d) { n = Number(n); return Number.isInteger(n) && n >= 0 && n < len ? n : d; }
  function pick(list, v, d) { return list.indexOf(v) >= 0 ? v : d; }
  function normalize(a) {
    a = a || {};
    return {
      skin: idx(a.skin, C.skin.length, 1), hair: pick(HAIRS, a.hair, 'short'), hairColor: idx(a.hairColor, C.hair.length, 1),
      eyes: pick(EYES, a.eyes, 'round'), hat: pick(HATS, a.hat, 'hardhat'), hatColor: idx(a.hatColor, C.color.length, 0),
      beard: pick(BEARDS, a.beard, 'none'), shirt: idx(a.shirt, C.shirt.length, 0), vest: a.vest === 'yes' ? 'yes' : 'none',
      pants: idx(a.pants, C.pants.length, 0), tool: pick(TOOLS, a.tool, 'hammer'), extra: pick(EXTRAS, a.extra, 'none'),
      clipboard: !!a.clipboard, mood: a.mood === 'frown' ? 'frown' : a.mood === 'happy' ? 'happy' : 'smile', elder: !!a.elder,
    };
  }
  function shade(hex, amt) {
    var n = parseInt(hex.slice(1), 16);
    var r = Math.max(0, Math.min(255, (n >> 16) + amt)), g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt)), b = Math.max(0, Math.min(255, (n & 255) + amt));
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  // ── the pose: every number the parts read, derived from pose + time ─────────────────────────────────────────────
  // Units: the character is drawn in a 100-wide × 120-tall box, feet at y = 120, head centre near (50, 40).
  function poseOf(pose, t, o) {
    var p = { bob: 0, lean: 0, tilt: 0, armL: 0, armR: 0, legL: 0, legR: 0, armRUp: 0, armLUp: 0, jump: 0, sx: 1, sy: 1,
      mouth: 'smile', browUp: 0, browDown: 0, eyesClosed: false, look: 0, fist: false, mouthOpen: 0 };
    var m = reduce ? 0 : 1, s = Math.sin, c = Math.cos;
    if (o.blink !== false) { var cyc = (t + (o.seed || 0)) % 3600; p.eyesClosed = !!(cyc > 3450 && m); }
    if (pose === 'walk') { p.legL = s(t / 95) * 24 * m; p.legR = -p.legL; p.armL = s(t / 95) * 18 * m; p.armR = -p.armL; p.bob = Math.abs(s(t / 95)) * -2.2 * m; p.lean = 4; }
    else if (pose === 'knock') { p.armRUp = 1; p.armR = -70 + s(t / 45) * 22 * m; p.fist = true; p.lean = 7; p.browUp = 1; }
    else if (pose === 'talk') { p.mouthOpen = (0.5 + 0.5 * s(t / 70)) * m; if (m === 0) p.mouthOpen = 0.6; p.tilt = s(t / 400) * 2 * m; p.armR = -10 + s(t / 300) * 8 * m; p.browUp = 1; }
    else if (pose === 'cheer') { p.armLUp = 1; p.armRUp = 1; p.armL = 150 + s(t / 110) * 14 * m; p.armR = -150 - s(t / 110) * 14 * m; p.jump = Math.abs(s(t / 170)) * 7 * m; p.mouth = 'open'; p.mouthOpen = 1; p.sy = 1 + s(t / 170) * 0.03 * m; p.sx = 1 - s(t / 170) * 0.03 * m; p.browUp = 1; }
    else if (pose === 'sad') { p.tilt = 7; p.browDown = 1; p.mouth = 'frown'; p.bob = 3; p.armL = 6; p.armR = -6; p.look = 1; }
    else if (pose === 'wave') { p.armRUp = 1; p.armR = -140 + s(t / 120) * 25 * m; p.mouth = 'open'; p.mouthOpen = 0.6; p.browUp = 1; p.bob = s(t / 300) * -1 * m; }
    else if (pose === 'think') { p.armRUp = 1; p.armR = -158 + s(t / 500) * 3 * m; p.look = -1; p.browUp = 0.5; p.tilt = -4; p.mouth = 'flat'; }
    else { p.bob = s(t / 650) * -1.2 * m; p.sy = 1 + s(t / 650) * 0.012 * m; p.armL = s(t / 650) * 2 * m; p.armR = -p.armL; var gl = (t + (o.seed || 0) * 3) % 6400; if (m && gl > 5200) p.look = gl > 5800 ? -1 : 1; } // a glance to each side every 6.4 s
    if (o.mood === 'frown' && pose !== 'cheer' && pose !== 'wave') { p.mouth = p.mouth === 'open' ? 'open' : 'frown'; p.browDown = Math.max(p.browDown, 0.7); }
    if (o.mood === 'happy' && pose !== 'sad') { p.happyEyes = true; p.browUp = Math.max(p.browUp, 0.6); if (p.mouth === 'smile') p.mouth = 'grin'; }
    return p;
  }

  // ── drawing helpers (every part: stroke the outline first, then fill, so overlaps stay clean) ───────────────────
  function Pen(ctx, s) {
    this.c = ctx; this.s = s; this.lw = Math.max(1.1, 2.6 * s);
  }
  Pen.prototype.path = function (fn) { this.c.beginPath(); fn(this.c); this.c.closePath(); };
  Pen.prototype.shape = function (fn, fill, noLine) {
    var c = this.c; this.path(fn);
    if (!noLine) { c.lineWidth = this.lw; c.lineJoin = 'round'; c.lineCap = 'round'; c.strokeStyle = INK; c.stroke(); }
    c.fillStyle = fill; c.fill();
  };
  Pen.prototype.grad = function (x0, y0, x1, y1, a, b) { var g = this.c.createLinearGradient(x0, y0, x1, y1); g.addColorStop(0, a); g.addColorStop(1, b); return g; };
  Pen.prototype.circle = function (x, y, r, fill, noLine) { this.shape(function (c) { c.arc(x, y, r, 0, Math.PI * 2); }, fill, noLine); };
  Pen.prototype.ellipse = function (x, y, rx, ry, rot, fill, noLine) { this.shape(function (c) { c.ellipse(x, y, rx, ry, rot || 0, 0, Math.PI * 2); }, fill, noLine); };
  Pen.prototype.rrect = function (x, y, w, h, r, fill, noLine) {
    this.shape(function (c) { c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); }, fill, noLine);
  };
  Pen.prototype.poly = function (pts, fill, noLine) { this.shape(function (c) { c.moveTo(pts[0][0], pts[0][1]); for (var i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]); }, fill, noLine); };
  Pen.prototype.line = function (x0, y0, x1, y1, w, col) { var c = this.c; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.lineWidth = w; c.lineCap = 'round'; c.strokeStyle = col || INK; c.stroke(); };
  Pen.prototype.limb = function (x0, y0, x1, y1, w, fill) {
    // a capsule limb: outline then fill, with a round end
    var c = this.c; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.lineCap = 'round'; c.lineJoin = 'round';
    c.lineWidth = w + this.lw * 2; c.strokeStyle = INK; c.stroke();
    c.lineWidth = w; c.strokeStyle = fill; c.stroke();
  };

  // ── the character ────────────────────────────────────────────────────────────────────────────────────────────────
  function draw(ctx, look, o) {
    o = o || {};
    var a = normalize(look), pose = pick(POSES, o.pose, 'idle'), t = o.t == null ? 0 : o.t;
    if (a.hair === 'spiky' && a.hat !== 'none') a.hair = 'short'; // spikes tuck under a hat
    var p = poseOf(pose, t, { mood: o.mood || a.mood, blink: o.blink, seed: o.seed });
    var h = o.h || 120, s = h / 120, x = o.x || 0, y = o.y || h, facing = o.facing === -1 ? -1 : 1;
    var skin = C.skin[a.skin], hair = C.hair[a.hairColor], hatC = C.color[a.hatColor], shirt = C.shirt[a.shirt], pants = C.pants[a.pants];
    var pen = new Pen(ctx, s);
    ctx.save();
    // ground shadow (never bobs: the character leaves it when jumping)
    if (o.shadow !== false) { ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.beginPath(); ctx.ellipse(x, y - 1 * s, 22 * s * (1 - p.jump / 40), 5 * s, 0, 0, Math.PI * 2); ctx.fill(); }
    ctx.translate(x, y - (p.jump + Math.max(0, -p.bob) * 0) * s);
    ctx.scale(facing * s * p.sx, s * p.sy);
    ctx.translate(-50, -120);
    // breathing / walking bob moves the whole body
    ctx.translate(0, p.bob);

    var shirtG = pen.grad(30, 70, 70, 112, shade(shirt, 22), shade(shirt, -16));
    var pantsG = pen.grad(30, 100, 70, 120, shade(pants, 14), shade(pants, -14));
    var skinG = pen.grad(25, 15, 75, 70, shade(skin, 14), shade(skin, -12));
    var hairG = pen.grad(25, 5, 75, 50, shade(hair, 26), shade(hair, -18));
    var hatG = pen.grad(25, 0, 75, 40, shade(hatC, 34), shade(hatC, -22));

    // back hair (behind the head): long hair, the ponytail
    if (a.hair === 'long') { pen.rrect(21, 30, 58, 50, 14, hairG); }
    if (a.hair === 'ponytail') { pen.shape(function (c) { c.moveTo(70, 30); c.quadraticCurveTo(92, 36, 86, 66); c.quadraticCurveTo(80, 60, 74, 48); c.quadraticCurveTo(76, 40, 70, 30); }, hairG); }

    // legs (hip at 50,98): short chibi legs, boots
    var legW = 11;
    function leg(dx, ang) {
      ctx.save(); ctx.translate(50 + dx, 98); ctx.rotate(ang * Math.PI / 180);
      pen.limb(0, 0, 0, 16, legW, pantsG);
      pen.rrect(-7, 13, 14, 8, 4, '#4A3424');
      ctx.restore();
    }
    leg(-8, p.legL); leg(8, p.legR);

    // torso
    pen.shape(function (c) { c.moveTo(32, 74); c.quadraticCurveTo(50, 68, 68, 74); c.lineTo(72, 100); c.quadraticCurveTo(50, 106, 28, 100); c.closePath(); }, shirtG);
    if (a.vest === 'yes') {
      pen.poly([[33, 75], [43, 72], [45, 100], [31, 100]], VEST); pen.poly([[57, 72], [67, 75], [69, 100], [55, 100]], VEST);
      ctx.fillStyle = '#D7D7D7'; ctx.fillRect(32, 86, 12, 3); ctx.fillRect(56, 86, 12, 3);
      ctx.fillStyle = VESTD; ctx.fillRect(32, 97, 12, 2); ctx.fillRect(56, 97, 12, 2);
    }
    if (a.extra === 'belt') { pen.rrect(29, 96, 42, 6, 2, '#7A4A22'); ctx.fillStyle = '#E0B45A'; ctx.fillRect(46, 97, 8, 4); ctx.fillStyle = '#9AA0A6'; ctx.fillRect(33, 101, 6, 4); ctx.fillStyle = '#7A4A22'; ctx.fillRect(60, 101, 5, 4); }
    // a collar line
    ctx.strokeStyle = 'rgba(0,0,0,.18)'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(44, 74); ctx.lineTo(50, 80); ctx.lineTo(56, 74); ctx.stroke();

    // arms: shoulder pivots at (34,78) and (66,78); angle 0 hangs down, negative swings forward / up on the right
    function arm(sx, sy, ang, up, fist, side) {
      ctx.save(); ctx.translate(sx, sy); ctx.rotate(ang * Math.PI / 180);
      pen.limb(0, 0, 0, up ? 20 : 18, 9, shirtG);
      pen.circle(0, up ? 21 : 19, fist ? 5.5 : 5, skinG);
      if (fist) { ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(0, 21, 3, Math.PI * 0.2, Math.PI * 0.8); ctx.stroke(); }
      ctx.restore();
    }
    // the left (back) arm
    arm(34, 78, p.armLUp ? p.armL : p.armL, p.armLUp, false, -1);
    if (a.clipboard) { ctx.save(); ctx.translate(34, 78); ctx.rotate(p.armL * Math.PI / 180); pen.rrect(-12, 8, 14, 18, 2, '#B98A4E'); pen.rrect(-10, 11, 10, 13, 1, '#F5F5F0', true); ctx.fillStyle = '#8A8F96'; ctx.fillRect(-8, 7, 6, 3); ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.lineWidth = 1; for (var li = 0; li < 3; li++) { ctx.beginPath(); ctx.moveTo(-8, 14 + li * 3); ctx.lineTo(-2, 14 + li * 3); ctx.stroke(); } ctx.restore(); }

    // head: a soft circle with a chin, ears, shading and a highlight
    var hx = 50, hy = 42, hr = 29;
    ctx.save(); ctx.translate(hx, hy); ctx.rotate(p.tilt * Math.PI / 180); ctx.translate(p.lean * 0.4, 0); ctx.translate(-hx, -hy);
    pen.circle(hx - hr + 1, hy + 4, 5, skinG); pen.circle(hx + hr - 1, hy + 4, 5, skinG);
    pen.shape(function (c) { c.moveTo(hx - hr, hy - 4); c.quadraticCurveTo(hx - hr, hy - hr - 2, hx, hy - hr - 2); c.quadraticCurveTo(hx + hr, hy - hr - 2, hx + hr, hy - 4); c.quadraticCurveTo(hx + hr + 1, hy + 26, hx, hy + 31); c.quadraticCurveTo(hx - hr - 1, hy + 26, hx - hr, hy - 4); }, skinG);
    // highlight on the forehead
    ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.beginPath(); ctx.ellipse(hx - 10, hy - 14, 9, 5, -0.5, 0, Math.PI * 2); ctx.fill();
    if (a.elder) { ctx.strokeStyle = 'rgba(0,0,0,.18)'; ctx.lineWidth = 1; [[-16, 20], [16, 20]].forEach(function (w) { ctx.beginPath(); ctx.moveTo(hx + w[0], hy + w[1] - 3); ctx.quadraticCurveTo(hx + w[0] * 1.1, hy + w[1], hx + w[0] * 0.9, hy + w[1] + 4); ctx.stroke(); }); }
    // cheeks
    if (p.mouth !== 'frown') { ctx.fillStyle = BLUSH; [[-19, 12], [19, 12]].forEach(function (b) { ctx.beginPath(); ctx.ellipse(hx + b[0], hy + b[1], 6, 3.5, 0, 0, Math.PI * 2); ctx.fill(); }); }

    // eyes (centres 50±12, hy+4)
    var eyL = hx - 12, eyR = hx + 12, ey = hy + 4, lookX = p.look * 1.5;
    function roundEye(cx, closed) {
      if (closed) { pen.line(cx - 5, ey + 1, cx + 5, ey + 1, 2.4); return; }
      pen.ellipse(cx, ey, 6, 7.5, 0, WHITE);
      ctx.fillStyle = '#3A2A26'; ctx.beginPath(); ctx.ellipse(cx + lookX, ey + 1.5, 4, 5.5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#5A4A44'; ctx.beginPath(); ctx.ellipse(cx + lookX, ey + 3, 2.6, 3, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = WHITE; ctx.beginPath(); ctx.arc(cx - 1.6 + lookX, ey - 1.2, 1.9, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + 1.8 + lookX, ey + 3.4, 0.9, 0, Math.PI * 2); ctx.fill();
    }
    function happyEye(cx) { ctx.strokeStyle = INK; ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.beginPath(); ctx.arc(cx, ey + 3, 5.5, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke(); }
    function sleepyEye(cx, closed) {
      if (closed) { pen.line(cx - 5, ey + 1, cx + 5, ey + 1, 2.4); return; }
      pen.ellipse(cx, ey + 1, 6, 5, 0, WHITE);
      ctx.fillStyle = '#3A2A26'; ctx.beginPath(); ctx.ellipse(cx + lookX, ey + 2.5, 3.6, 3.6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = WHITE; ctx.beginPath(); ctx.arc(cx - 1.4 + lookX, ey + 1, 1.3, 0, Math.PI * 2); ctx.fill();
      pen.shape(function (c) { c.moveTo(cx - 7, ey - 6); c.quadraticCurveTo(cx, ey - 1, cx + 7, ey - 6); c.lineTo(cx + 7, ey - 1.5); c.quadraticCurveTo(cx, ey - 3, cx - 7, ey - 1.5); }, skinG, true);
      pen.line(cx - 6, ey - 1.5, cx + 6, ey - 1.5, 2);
    }
    var shades = a.extra === 'shades';
    if (!shades) {
      if (a.eyes === 'happy' || pose === 'cheer' || p.happyEyes) { happyEye(eyL); happyEye(eyR); }
      else if (a.eyes === 'wink') { roundEye(eyL, p.eyesClosed); happyEye(eyR); }
      else if (a.eyes === 'sleepy') { sleepyEye(eyL, p.eyesClosed); sleepyEye(eyR, p.eyesClosed); }
      else { roundEye(eyL, p.eyesClosed); roundEye(eyR, p.eyesClosed); }
    }
    // brows
    var browC = a.hair === 'bald' ? shade(skin, -40) : shade(hair, -10), bUp = p.browUp * 2.5, bDn = p.browDown;
    ctx.strokeStyle = browC; ctx.lineWidth = 2.6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(eyL - 6, ey - 11 - bUp + bDn * 2); ctx.quadraticCurveTo(eyL, ey - 14 - bUp + bDn * 1, eyL + 6, ey - 11 - bUp - bDn * 2 + bDn * 4); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(eyR - 6, ey - 11 - bUp - bDn * 2 + bDn * 4); ctx.quadraticCurveTo(eyR, ey - 14 - bUp + bDn * 1, eyR + 6, ey - 11 - bUp + bDn * 2); ctx.stroke();
    // nose
    ctx.strokeStyle = 'rgba(0,0,0,.28)'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(hx + 1, ey + 6); ctx.quadraticCurveTo(hx + 3, ey + 9, hx, ey + 10); ctx.stroke();
    // mouth
    var my = hy + 19;
    if (p.mouth === 'open' || p.mouthOpen > 0.15) {
      var oh = 2 + 5 * Math.max(p.mouthOpen, p.mouth === 'open' ? 0.9 : 0);
      pen.ellipse(hx, my + 1, 5 + oh * 0.4, oh, 0, '#6B2A2A');
      ctx.fillStyle = '#E2707F'; ctx.beginPath(); ctx.ellipse(hx, my + 1 + oh * 0.55, 3.2, oh * 0.4, 0, 0, Math.PI * 2); ctx.fill();
      if (oh > 4) { ctx.fillStyle = WHITE; ctx.fillRect(hx - 4, my + 1 - oh + 1.2, 8, 2.2); }
    } else if (p.mouth === 'frown') { ctx.strokeStyle = INK; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.moveTo(hx - 6, my + 3); ctx.quadraticCurveTo(hx, my - 2, hx + 6, my + 3); ctx.stroke(); }
    else if (p.mouth === 'flat') { pen.line(hx - 5, my + 1, hx + 5, my + 1, 2.4); }
    else if (p.mouth === 'grin') { pen.shape(function (c) { c.moveTo(hx - 8, my - 2); c.quadraticCurveTo(hx, my + 9, hx + 8, my - 2); c.quadraticCurveTo(hx, my + 2, hx - 8, my - 2); }, '#6B2A2A'); ctx.fillStyle = WHITE; ctx.fillRect(hx - 5, my - 1, 10, 1.8); }
    else { ctx.strokeStyle = INK; ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(hx - 7, my - 1); ctx.quadraticCurveTo(hx, my + 6, hx + 7, my - 1); ctx.stroke(); }
    // beard
    if (a.beard === 'stubble') { ctx.fillStyle = 'rgba(0,0,0,.16)'; ctx.beginPath(); ctx.moveTo(hx - 22, hy + 10); ctx.quadraticCurveTo(hx - 24, hy + 28, hx, hy + 31); ctx.quadraticCurveTo(hx + 24, hy + 28, hx + 22, hy + 10); ctx.quadraticCurveTo(hx + 10, hy + 22, hx, hy + 24); ctx.quadraticCurveTo(hx - 10, hy + 22, hx - 22, hy + 10); ctx.fill(); }
    else if (a.beard === 'mustache') { pen.shape(function (c) { c.moveTo(hx - 12, my - 2); c.quadraticCurveTo(hx - 6, my - 8, hx, my - 4); c.quadraticCurveTo(hx + 6, my - 8, hx + 12, my - 2); c.quadraticCurveTo(hx + 6, my - 1, hx, my - 3); c.quadraticCurveTo(hx - 6, my - 1, hx - 12, my - 2); }, hairG); }
    else if (a.beard === 'full') {
      pen.shape(function (c) { c.moveTo(hx - 24, hy + 6); c.quadraticCurveTo(hx - 27, hy + 30, hx, hy + 36); c.quadraticCurveTo(hx + 27, hy + 30, hx + 24, hy + 6); c.quadraticCurveTo(hx + 14, hy + 18, hx + 9, my - 3); c.lineTo(hx - 9, my - 3); c.quadraticCurveTo(hx - 14, hy + 18, hx - 24, hy + 6); }, hairG);
      pen.shape(function (c) { c.moveTo(hx - 12, my - 2); c.quadraticCurveTo(hx - 6, my - 8, hx, my - 4); c.quadraticCurveTo(hx + 6, my - 8, hx + 12, my - 2); c.quadraticCurveTo(hx + 6, my - 1, hx, my - 3); c.quadraticCurveTo(hx - 6, my - 1, hx - 12, my - 2); }, hairG);
      if (!(p.mouth === 'open' || p.mouthOpen > 0.15)) { if (p.mouth === 'frown') { ctx.strokeStyle = INK; ctx.lineWidth = 2.2; ctx.beginPath(); ctx.moveTo(hx - 5, my + 3); ctx.quadraticCurveTo(hx, my, hx + 5, my + 3); ctx.stroke(); } else { ctx.strokeStyle = INK; ctx.lineWidth = 2.2; ctx.beginPath(); ctx.moveTo(hx - 5, my); ctx.quadraticCurveTo(hx, my + 4, hx + 5, my); ctx.stroke(); } }
    }

    // front hair
    var top = hy - hr - 2;
    if (a.hair === 'short') { pen.shape(function (c) { c.moveTo(hx - hr - 1, hy - 2); c.quadraticCurveTo(hx - hr - 2, top - 4, hx, top - 5); c.quadraticCurveTo(hx + hr + 2, top - 4, hx + hr + 1, hy - 2); c.quadraticCurveTo(hx + hr - 4, hy - 10, hx + 12, hy - 16); c.quadraticCurveTo(hx, hy - 8, hx - 10, hy - 17); c.quadraticCurveTo(hx - hr + 2, hy - 12, hx - hr - 1, hy - 2); }, hairG); }
    else if (a.hair === 'spiky') { pen.shape(function (c) { c.moveTo(hx - hr - 1, hy - 2); c.lineTo(hx - hr - 6, top - 10); c.lineTo(hx - 16, top - 5); c.lineTo(hx - 10, top - 16); c.lineTo(hx - 3, top - 6); c.lineTo(hx + 4, top - 17); c.lineTo(hx + 10, top - 5); c.lineTo(hx + 20, top - 14); c.lineTo(hx + hr + 1, hy - 2); c.quadraticCurveTo(hx + 12, hy - 14, hx, hy - 12); c.quadraticCurveTo(hx - 12, hy - 14, hx - hr - 1, hy - 2); }, hairG); }
    else if (a.hair === 'long') { pen.shape(function (c) { c.moveTo(hx - hr - 1, hy + 2); c.quadraticCurveTo(hx - hr - 3, top - 4, hx, top - 5); c.quadraticCurveTo(hx + hr + 3, top - 4, hx + hr + 1, hy + 2); c.quadraticCurveTo(hx + hr - 6, hy - 10, hx + 8, hy - 14); c.quadraticCurveTo(hx - 4, hy - 6, hx - 14, hy - 16); c.quadraticCurveTo(hx - hr + 4, hy - 12, hx - hr - 1, hy + 2); }, hairG); }
    else if (a.hair === 'buzz') { pen.shape(function (c) { c.moveTo(hx - hr + 1, hy - 6); c.quadraticCurveTo(hx - hr, top, hx, top - 1); c.quadraticCurveTo(hx + hr, top, hx + hr - 1, hy - 6); c.quadraticCurveTo(hx, hy - 12, hx - hr + 1, hy - 6); }, shade(hair, -14), true); ctx.strokeStyle = INK; ctx.lineWidth = pen.lw * 0.6; ctx.beginPath(); ctx.moveTo(hx - hr + 1, hy - 6); ctx.quadraticCurveTo(hx, hy - 12, hx + hr - 1, hy - 6); ctx.stroke(); }
    else if (a.hair === 'ponytail') { pen.shape(function (c) { c.moveTo(hx - hr - 1, hy - 2); c.quadraticCurveTo(hx - hr - 2, top - 4, hx, top - 5); c.quadraticCurveTo(hx + hr + 2, top - 4, hx + hr + 1, hy - 2); c.quadraticCurveTo(hx + 20, hy - 12, hx + 6, hy - 20); c.quadraticCurveTo(hx - 6, hy - 10, hx - 16, hy - 18); c.quadraticCurveTo(hx - hr + 2, hy - 12, hx - hr - 1, hy - 2); }, hairG); }
    if (a.hair !== 'bald' && a.hair !== 'buzz') { ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.beginPath(); ctx.ellipse(hx - 12, top + 2, 8, 2.6, -0.3, 0, Math.PI * 2); ctx.fill(); }

    // hats
    if (a.hat === 'hardhat') {
      pen.shape(function (c) { c.moveTo(hx - hr - 6, hy - 10); c.quadraticCurveTo(hx - hr - 2, top - 14, hx, top - 16); c.quadraticCurveTo(hx + hr + 2, top - 14, hx + hr + 6, hy - 10); c.quadraticCurveTo(hx, hy - 6, hx - hr - 6, hy - 10); }, hatG);
      pen.rrect(hx - 5, top - 18, 10, 14, 4, shade(hatC, 30), true);
      pen.shape(function (c) { c.moveTo(hx - hr - 8, hy - 10); c.quadraticCurveTo(hx, hy - 2, hx + hr + 8, hy - 10); c.quadraticCurveTo(hx, hy - 6, hx - hr - 8, hy - 10); }, shade(hatC, -34));
      ctx.fillStyle = 'rgba(255,255,255,.3)'; ctx.beginPath(); ctx.ellipse(hx - 14, top - 6, 7, 3, -0.4, 0, Math.PI * 2); ctx.fill();
    } else if (a.hat === 'cap') {
      pen.shape(function (c) { c.moveTo(hx - hr - 2, hy - 8); c.quadraticCurveTo(hx - hr, top - 10, hx, top - 11); c.quadraticCurveTo(hx + hr, top - 10, hx + hr + 2, hy - 8); c.quadraticCurveTo(hx, hy - 4, hx - hr - 2, hy - 8); }, hatG);
      pen.shape(function (c) { c.moveTo(hx + 2, hy - 7); c.quadraticCurveTo(hx + hr + 8, hy - 10, hx + hr + 16, hy - 2); c.quadraticCurveTo(hx + hr + 4, hy, hx + 2, hy - 4); }, shade(hatC, -28));
      pen.circle(hx, top - 11, 2.5, shade(hatC, 30), true);
      ctx.fillStyle = 'rgba(255,255,255,.3)'; ctx.beginPath(); ctx.ellipse(hx - 12, top - 4, 7, 2.6, -0.3, 0, Math.PI * 2); ctx.fill();
    } else if (a.hat === 'beanie') {
      pen.shape(function (c) { c.moveTo(hx - hr - 2, hy - 2); c.quadraticCurveTo(hx - hr - 2, top - 12, hx, top - 14); c.quadraticCurveTo(hx + hr + 2, top - 12, hx + hr + 2, hy - 2); c.lineTo(hx + hr + 2, hy + 2); c.quadraticCurveTo(hx, hy - 1, hx - hr - 2, hy + 2); }, hatG);
      pen.rrect(hx - hr - 3, hy - 6, hr * 2 + 6, 8, 3, shade(hatC, -22));
      ctx.strokeStyle = 'rgba(0,0,0,.18)'; ctx.lineWidth = 1; for (var bx = hx - hr + 2; bx < hx + hr; bx += 5) { ctx.beginPath(); ctx.moveTo(bx, hy - 5); ctx.lineTo(bx + 2, hy + 1); ctx.stroke(); }
      pen.circle(hx, top - 15, 5, shade(hatC, 30));
    }

    // eyewear (over the hair and hat brims)
    if (a.extra === 'glasses') {
      ctx.strokeStyle = '#4A5A6B'; ctx.lineWidth = 2; [eyL, eyR].forEach(function (cx) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(cx - 8.5, ey - 7.5, 17, 15, 4) : ctx.rect(cx - 8.5, ey - 7.5, 17, 15); ctx.stroke(); ctx.fillStyle = 'rgba(156,211,240,.28)'; ctx.fill(); });
      ctx.beginPath(); ctx.moveTo(eyL + 8.5, ey - 1); ctx.lineTo(eyR - 8.5, ey - 1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(eyL - 8.5, ey - 1); ctx.lineTo(hx - hr + 2, ey - 3); ctx.moveTo(eyR + 8.5, ey - 1); ctx.lineTo(hx + hr - 2, ey - 3); ctx.stroke();
    } else if (shades) {
      [eyL, eyR].forEach(function (cx) { pen.rrect(cx - 9, ey - 7, 18, 13, 5, pen.grad(cx - 9, ey - 7, cx + 9, ey + 6, '#3A3F4A', '#0E1116')); ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.beginPath(); ctx.ellipse(cx - 3, ey - 3, 4, 1.6, -0.4, 0, Math.PI * 2); ctx.fill(); });
      pen.line(eyL + 9, ey - 3, eyR - 9, ey - 3, 2.4); pen.line(eyL - 9, ey - 3, hx - hr + 1, ey - 5, 2.4); pen.line(eyR + 9, ey - 3, hx + hr - 1, ey - 5, 2.4);
    }
    ctx.restore(); // head

    // the right (front) arm and whatever it holds
    arm(66, 78, p.armR, p.armRUp, p.fist, 1);
    if (!p.fist && !p.armRUp) {
      ctx.save(); ctx.translate(66, 78); ctx.rotate(p.armR * Math.PI / 180); ctx.translate(0, 19);
      if (a.tool === 'hammer') { pen.rrect(-2, -2, 4, 24, 2, '#8B5A2B'); pen.rrect(-9, -8, 18, 8, 2, pen.grad(-9, -8, 9, 0, '#B4B8BD', '#6F747A')); }
      else if (a.tool === 'tape') { pen.rrect(-7, -3, 14, 13, 4, '#F2C200'); pen.circle(0, 3.5, 3.2, '#2C2C2A', true); ctx.fillStyle = '#E8E4DA'; ctx.fillRect(6, 1, 8, 2.5); }
      else if (a.tool === 'ladder') { ctx.translate(10, -40); pen.rrect(0, 0, 4, 62, 2, '#B4B2A9'); pen.rrect(14, 0, 4, 62, 2, '#B4B2A9'); for (var ry = 6; ry < 60; ry += 9) pen.rrect(2, ry, 14, 3.5, 1.5, '#8F8D86'); }
      ctx.restore();
    }
    ctx.restore();
  }

  function paintCanvas(canvas, look, o) {
    o = o || {};
    var dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    var rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { width: 0, height: 0 };
    var cw = Math.round(rect.width) || canvas.width || 64, ch = Math.round(rect.height) || canvas.height || 64;
    if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) { canvas.width = cw * dpr; canvas.height = ch * dpr; }
    var ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, cw, ch);
    var h = (o.fit || 0.86) * ch, y = ch - (ch - h) / 2 + 2, shadow = o.shadow !== false;
    if (o.crop === 'bust') { var us = (ch - 4) / 100; h = 120 * us; y = 2 + 128 * us; shadow = false; } // hat brim to mid-torso fills the box
    draw(ctx, look, { x: cw / 2, y: y, h: h, t: o.t == null ? 0 : o.t, pose: o.pose, facing: o.facing, shadow: shadow, mood: o.mood, blink: o.blink, seed: o.seed });
  }
  var loops = 0;
  function animate(canvas, look, fn) {
    var alive = true, raf = 0, seed = Math.floor(Math.random() * 3000);
    if (canvas.__chibiStop) canvas.__chibiStop();
    function frame() {
      if (!alive) return;
      if (canvas.isConnected === false) { stop(); return; }
      var o = fn ? (fn(Date.now()) || {}) : {}; o.t = Date.now(); if (o.seed == null) o.seed = seed;
      paintCanvas(canvas, look, o);
      if (reduce) { alive = false; return; }
      raf = requestAnimationFrame(frame);
    }
    loops++;
    frame();
    var stop = function () { if (!alive) return; alive = false; loops--; if (raf) cancelAnimationFrame(raf); if (canvas.__chibiStop === stop) canvas.__chibiStop = null; };
    canvas.__chibiStop = stop;
    return stop;
  }

  window.NBDChibi = { draw: draw, paintCanvas: paintCanvas, animate: animate, normalize: normalize, poseOf: poseOf, POSES: POSES, C: C, reduce: reduce, _loops: function () { return loops; } };
})();
