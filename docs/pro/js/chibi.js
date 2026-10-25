/**
 * chibi.js — the NBD Pro character renderer (2026-10-25, Jo: "make the characters, sprites and animations as high
 * quality as we can").
 *
 * One vector chibi, drawn with Canvas 2D paths at any size: a big round head with soft shading and a highlight, big
 * shiny eyes that blink, rosy cheeks, a small body, a clean dark outline around every part (the "sticker" look), and
 * eleven animated poses. It replaces the 32×32 pixel grid on the Roof Rep street, in the speech sheet, the locker, the
 * HUD and the tutorial, and on the CRM game card. The parts and palette are the same ones the pixel sprite used, so
 * every saved avatar renders as the same person, just drawn properly.
 *
 * Wave 2 (later on 2026-10-25): arms and legs bend at the elbow and knee; poses cross-fade into each other over 220 ms
 * instead of popping (NBDChibi.tween keeps the state for callers that draw by hand); hair, ponytails and hats carry
 * secondary motion (they lag the body and bounce on a jump); walking squashes on each footfall; talking varies the
 * mouth like speech instead of a metronome; emotes float by the head (sparkles on a cheer, a sweat drop when sad,
 * thought dots when thinking); a neck shadow and a hat-brim shadow ground the head; and three new poses: point, nod,
 * shrug.
 *
 *   NBDChibi.draw(ctx, look, o)        — draw into any 2D context. o: { x, y: feet centre, h: height in px,
 *                                         t: ms, pose, facing: 1|-1, shadow: true, mood, blink: true,
 *                                         from, mix: the pose to cross-fade from and how far (0..1) }
 *   NBDChibi.paintCanvas(canvas, look, o) — size the bitmap to the canvas's CSS box × devicePixelRatio and draw the
 *                                         character to fit (used for every avatar canvas on the pages)
 *   NBDChibi.animate(canvas, look, fn) — a requestAnimationFrame loop (fn(t) returns the options per frame); returns
 *                                         stop(). Under prefers-reduced-motion it draws one still frame.
 *   NBDChibi.tween(state, pose, now)   — pose + from + mix for a caller that draws by hand (the street): give it the
 *                                         same state object every frame
 *   Looks: hair short · spiky · long · buzz · ponytail · bald · curly · afro · bun; top tee · hoodie · polo (wave 4);
 *          prop phone · mug · cane · keys · baby · brush · papers in the back hand (wave 7: what a homeowner carries);
 *          umbrella (wave 8: the back arm goes up and a canopy sits over the head). Draw option wind 0..1 gusts the hair,
 *          lifts the hat and leans the body (wave 8). Idle fidgets every 9 s: a weight shift, hands on the hips, a
 *          stretch and yawn (wave 9), so a character that is doing nothing still looks alive. Builds (wave 12): regular ·
 *          slim · stocky · tall scale the body and the head apart (what the hands hold keeps its shape); an elder look
 *          stoops. Gaze (wave 13): draw option gaze { x, y } (-1..1, screen space) turns the eyes and tilts the head toward
 *          a point; animate() feeds it the pointer, so every avatar on a page watches the cursor or a finger for a few
 *          seconds after it moves (gaze: false in the per-frame options opts a canvas out). Wave 14: a loop pops its
 *          character in over its first 360 ms (a squash, an overshoot, settle; pop: false opts out), a tap on any
 *          animated canvas gets a wave back for 1.2 s unless the page handles taps itself (poke: false, or a canvas that
 *          already has a __chibiTap handler), and every fourth blink is a double blink. Draw option pop 0..1 is the
 *          pop-in's progress for callers that draw by hand. Wave 15: draw option cold 0..1 puffs breath from the mouth
 *          every 3.2 s (the street passes it in winter).
 *   NBDChibi.POSES                     — idle · walk · knock · talk · cheer · sad · wave · think · point · nod · shrug ·
 *                                         hammer (a swing, the tool stays in hand) · climb (a ladder, rungs in both hands)
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
  var HAIRS = ['short', 'spiky', 'long', 'buzz', 'ponytail', 'bald', 'curly', 'afro', 'bun'], EYES = ['round', 'happy', 'wink', 'sleepy'];
  var TOPS = ['tee', 'hoodie', 'polo'];
  var HATS = ['hardhat', 'cap', 'beanie', 'none'], BEARDS = ['none', 'stubble', 'mustache', 'full'];
  var TOOLS = ['hammer', 'tape', 'ladder', 'none'], EXTRAS = ['none', 'glasses', 'shades', 'belt'], PROPS = ['none', 'phone', 'mug', 'cane', 'keys', 'baby', 'brush', 'papers', 'umbrella'];
  var POSES = ['idle', 'walk', 'knock', 'talk', 'cheer', 'sad', 'wave', 'think', 'point', 'nod', 'shrug', 'hammer', 'climb'];
  // wave 12: builds. w and h scale the body group (legs, torso, arms) from the feet; head scales the head on its own, so
  // a tall rep reads as tall (smaller head, longer body) and a stocky one as stocky (wider body, same head).
  var BUILDS = { regular: { w: 1, h: 1, head: 1 }, slim: { w: 0.88, h: 1.04, head: 0.96 }, stocky: { w: 1.2, h: 0.97, head: 1 }, tall: { w: 0.96, h: 1.12, head: 0.93 } };
  var BUILD_NAMES = ['regular', 'slim', 'stocky', 'tall'];
  var INK = '#1f1a17', WHITE = '#FFFFFF', BLUSH = 'rgba(242,120,120,.45)', VEST = '#C6E11C', VESTD = '#9DB51A';
  var TWEEN_MS = 220;
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
      top: pick(TOPS, a.top, 'tee'), prop: pick(PROPS, a.prop, 'none'), build: pick(BUILD_NAMES, a.build, 'regular'),
    };
  }
  // The body's height scale for a look (an elder stoops: a shorter body, the head carried lower) and how far that lifts
  // the head off its regular spot, in character units (negative when it drops). paintCanvas's bust crop uses the same number.
  function bodyH(a) { return BUILDS[a.build].h * (a.elder ? 0.96 : 1); }
  function headRise(a) { return 46 * (bodyH(a) - 1) - (a.elder ? 2 : 0); }
  function shade(hex, amt) {
    var n = parseInt(hex.slice(1), 16);
    var r = Math.max(0, Math.min(255, (n >> 16) + amt)), g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt)), b = Math.max(0, Math.min(255, (n & 255) + amt));
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  // ── the pose: every number the parts read, derived from pose + time ─────────────────────────────────────────────
  // Units: the character is drawn in a 100-wide × 120-tall box, feet at y = 120, head centre near (50, 40).
  // Arm angles: 0 hangs down, negative swings forward (toward the facing side) and on up; elbow angles add to the
  // upper arm (negative bends the forearm forward). Leg angles: positive swings the foot back; the knee bends back.
  function poseOf(pose, t, o) {
    var p = { bob: 0, lean: 0, tilt: 0, armL: 0, armR: 0, elbowL: -8, elbowR: -8, legL: 0, legR: 0, kneeL: 0, kneeR: 0, armRUp: 0, armLUp: 0,
      jump: 0, sx: 1, sy: 1, hair: 0, hat: 0, mouth: 'smile', browUp: 0, browDown: 0, eyesClosed: false, look: 0, fist: false,
      point: false, mouthOpen: 0, emote: null, swing: false };
    var m = reduce ? 0 : 1, s = Math.sin, c = Math.cos, seed = o.seed || 0;
    // a blink in the last 150 ms of every 3.6 s; every fourth one is a double blink (two 90 ms closes) (wave 14)
    if (o.blink !== false) { var cyc = (t + seed) % 3600, dbl = Math.floor((t + seed) / 3600) % 4 === 3; p.eyesClosed = !!(m && (dbl ? (cyc > 3300 && cyc < 3390) || (cyc > 3480 && cyc < 3570) : cyc > 3450)); }
    if (pose === 'walk') {
      var w = s(t / 95) * m, w2 = c(t / 95) * m;
      p.legL = w * 24; p.legR = -p.legL; p.kneeL = Math.max(0, p.legL) * 1.1; p.kneeR = Math.max(0, p.legR) * 1.1;
      p.armL = w * 18; p.armR = -p.armL; p.elbowL = -10 - Math.max(0, -p.armL) * 0.9; p.elbowR = -10 - Math.max(0, -p.armR) * 0.9;
      p.bob = Math.abs(w) * -2.4; p.sy = 1 - Math.abs(w2) * 0.025; p.sx = 1 + Math.abs(w2) * 0.02; p.lean = 4; p.tilt = -w * 1.5;
      p.hair = s(t / 95 - 1.1) * 7 * m;
    }
    else if (pose === 'knock') { p.armRUp = 1; p.armR = -58; p.elbowR = -62 + s(t / 45) * 24 * m; p.fist = true; p.lean = 7; p.browUp = 1; p.look = 1; }
    else if (pose === 'talk') {
      var v = 0.52 + 0.42 * s(t / 70) * (0.55 + 0.45 * s(t / 190)) + 0.18 * s(t / 310);
      p.mouthOpen = Math.max(0, Math.min(1, v)) * m; if (m === 0) p.mouthOpen = 0.6;
      p.tilt = s(t / 400) * 2 * m; p.bob = s(t / 400) * -0.6 * m; p.armR = -12 + s(t / 300) * 10 * m; p.elbowR = -30 - s(t / 300) * 18 * m; p.browUp = 1;
      p.look = (t + seed) % 4200 > 3600 ? -1 : 0;
    }
    else if (pose === 'cheer') {
      var j = s(t / 170) * m;
      p.armLUp = 1; p.armRUp = 1; p.armL = 150 + j * 14; p.armR = -150 - j * 14; p.elbowL = 14 + j * 6; p.elbowR = -14 - j * 6;
      p.jump = Math.abs(j) * 7; p.mouth = 'open'; p.mouthOpen = 1; p.sy = 1 + j * 0.03; p.sx = 1 - j * 0.03; p.browUp = 1;
      p.hat = Math.max(0, c(t / 170)) * 2.2 * m; p.hair = -c(t / 170) * 6 * m; p.emote = 'sparkle';
    }
    else if (pose === 'sad') { p.tilt = 7; p.browDown = 1; p.mouth = 'frown'; p.bob = 3; p.armL = 6; p.armR = -6; p.elbowL = -2; p.elbowR = -2; p.look = 1; p.emote = 'sweat'; p.sy = 0.985; }
    else if (pose === 'wave') { p.armRUp = 1; p.armR = -140; p.elbowR = 20 + s(t / 120) * 28 * m; p.mouth = 'open'; p.mouthOpen = 0.6; p.browUp = 1; p.bob = s(t / 300) * -1 * m; p.tilt = s(t / 300) * 1.5 * m; }
    else if (pose === 'think') { p.armRUp = 1; p.armR = -118; p.elbowR = -130 + s(t / 500) * 3 * m; p.look = -1; p.browUp = 0.5; p.tilt = -4; p.mouth = 'flat'; p.emote = 'dots'; }
    else if (pose === 'point') { p.armRUp = 1; p.armR = -108 + s(t / 260) * 2 * m; p.elbowR = -6; p.point = true; p.browUp = 1; p.look = 1; p.lean = 3; p.mouth = 'open'; p.mouthOpen = 0.35; }
    else if (pose === 'nod') { var nd = s(t / 190) * m; p.tilt = nd * 4; p.bob = Math.max(0, nd) * 1.6; p.browUp = 0.5; p.hair = -nd * 3; p.armL = 2; p.armR = -2; p.mouth = 'grin'; }
    else if (pose === 'hammer') {
      // Wind up over the shoulder, strike down fast, hold a beat: a 520 ms cycle the tool rides along.
      var cyc2 = (t % 520) / 520, k = cyc2 < 0.6 ? cyc2 / 0.6 : 1 - (cyc2 - 0.6) / 0.4; k = k * k;
      p.armRUp = 1; p.swing = true; p.armR = -150 + k * 120 * m; p.elbowR = -40 + k * 30 * m; p.lean = 3 + k * 3 * m; p.tilt = -2 + k * 4 * m;
      p.armL = 10; p.elbowL = -20; p.browUp = 0.6; p.mouth = cyc2 > 0.6 && m ? 'open' : 'flat'; p.mouthOpen = cyc2 > 0.6 && m ? 0.4 : 0; p.sy = 1 - k * 0.02 * m;
    }
    else if (pose === 'climb') {
      // Hands on the rungs, one leg stepping up at a time, the body close to the ladder.
      var st = s(t / 240) * m;
      p.armLUp = 1; p.armRUp = 1; p.armL = 165 + st * 6; p.armR = -165 + st * 6; p.elbowL = 10; p.elbowR = -10;
      p.legL = -st * 16; p.legR = st * 16; p.kneeL = Math.max(0, -p.legL) * 1.6; p.kneeR = Math.max(0, -p.legR) * 1.6; p.bob = -Math.abs(st) * 1.5; p.browUp = 0.8; p.mouth = 'flat';
    }
    else if (pose === 'shrug') { p.armL = 38; p.armR = -38; p.elbowL = 74; p.elbowR = -74; p.browUp = 1; p.tilt = 5; p.mouth = 'flat'; p.bob = -1 + s(t / 500) * 0.5 * m; }
    else {
      p.bob = s(t / 650) * -1.2 * m; p.sy = 1 + s(t / 650) * 0.012 * m; p.armL = s(t / 650) * 2 * m; p.armR = -p.armL; p.hair = s(t / 650) * 1.5 * m; var gl = (t + seed * 3) % 6400; if (m && gl > 5200) p.look = gl > 5800 ? -1 : 1; // a glance to each side every 6.4 s
      // wave 9: a fidget in the last 1.2 s of every 9 s, a different one each cycle: shift the weight onto one foot,
      // hands on the hips with a head tilt, a stretch with a yawn. Each eases in and out so the body never pops. (The
      // arms are too short to reach the hat: a chibi's hand gets to the cheek at most.)
      var fc = (t + seed * 7) % 9000;
      if (m && fc > 7800) {
        var fe = s((fc - 7800) / 1200 * Math.PI), kind = (seed + Math.floor((t + seed * 7) / 9000)) % 3;
        if (kind === 0) { p.lean = fe * 4; p.tilt = fe * 3; p.legL = fe * 3; p.kneeL = fe * 4; p.bob -= fe * 1.5; }
        else if (kind === 1) { p.armL = 46 * fe; p.armR = -46 * fe; p.elbowL = 112 * fe; p.elbowR = -112 * fe; p.tilt = fe * 5; p.look = -1; p.browUp = fe * 0.6; }
        else { p.armL = 24 * fe; p.armR = -24 * fe; p.elbowL = 46 * fe; p.elbowR = -46 * fe; p.sy = 1 + fe * 0.035; p.bob -= fe * 2; if (fe > 0.45) { p.mouth = 'open'; p.mouthOpen = 0.55; p.eyesClosed = true; } }
      }
    }
    if (o.mood === 'frown' && pose !== 'cheer' && pose !== 'wave') { p.mouth = p.mouth === 'open' ? 'open' : 'frown'; p.browDown = Math.max(p.browDown, 0.7); }
    if (o.mood === 'happy' && pose !== 'sad') { p.happyEyes = true; p.browUp = Math.max(p.browUp, 0.6); if (p.mouth === 'smile') p.mouth = 'grin'; }
    return p;
  }
  // A cross-fade between two poses: numbers interpolate, everything else switches half way.
  function mixPose(a, b, k) {
    var r = {};
    for (var key in b) { var bv = b[key], av = a[key]; r[key] = typeof bv === 'number' && typeof av === 'number' ? av + (bv - av) * k : k < 0.5 ? av : bv; }
    return r;
  }
  // tween(state, pose, now): the caller keeps one state object per character; the result carries from + mix while a
  // change is still fading. Reduced motion snaps.
  function tween(st, pose, now, ms) {
    ms = ms || TWEEN_MS;
    if (st.pose !== pose) { st.from = st.pose || pose; st.pose = pose; st.since = now; }
    var k = reduce ? 1 : Math.min(1, (now - (st.since || 0)) / ms); k = k * k * (3 - 2 * k);
    return { pose: pose, from: k < 1 && st.from !== pose ? st.from : undefined, mix: k };
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
  // A jointed limb: two capsules sharing a joint. Both outlines go down first, then both fills, so the joint shows no seam.
  Pen.prototype.jointed = function (ang, len1, bend, len2, w, fill, cap) {
    var c = this.c, lw = this.lw, self = this;
    function trace(pass) {
      c.save(); c.rotate(ang * Math.PI / 180);
      c.beginPath(); c.moveTo(0, 0); c.lineTo(0, len1); c.translate(0, len1); c.rotate(bend * Math.PI / 180); c.lineTo(0, len2);
      c.lineCap = 'round'; c.lineJoin = 'round';
      if (pass === 0) { c.lineWidth = w + lw * 2; c.strokeStyle = INK; } else { c.lineWidth = w; c.strokeStyle = fill; }
      c.stroke();
      if (pass === 1 && cap) cap(self);
      c.restore();
    }
    trace(0); trace(1);
  };

  // ── the character ────────────────────────────────────────────────────────────────────────────────────────────────
  function draw(ctx, look, o) {
    o = o || {};
    var a = normalize(look), pose = pick(POSES, o.pose, 'idle'), t = o.t == null ? 0 : o.t;
    if (a.hair === 'spiky' && a.hat !== 'none') a.hair = 'short'; // spikes tuck under a hat
    var po = { mood: o.mood || a.mood, blink: o.blink, seed: o.seed };
    var p = poseOf(pose, t, po);
    if (o.from && o.mix != null && o.mix < 1 && POSES.indexOf(o.from) >= 0 && o.from !== pose) p = mixPose(poseOf(o.from, t, po), p, Math.max(0, o.mix));
    // wave 8: weather. A gust (0..1) swings the hair, lifts the hat and leans the body; an umbrella raises the back arm.
    var wind = Math.max(0, Math.min(1, Number(o.wind) || 0));
    if (wind) { var gust = wind * (0.55 + 0.45 * Math.sin(t / 230 + Math.sin(t / 1700) * 2)) * (reduce ? 0.6 : 1); p.hair += gust * 9; p.hat += gust * 1.6; p.lean += gust * 2; p.tilt += gust * 1.2; }
    if (a.prop === 'umbrella') { p.armLUp = 1; p.armL = 150; p.elbowL = 10; }
    var h = o.h || 120, s = h / 120, x = o.x || 0, y = o.y || h, facing = o.facing === -1 ? -1 : 1;
    // wave 14: pop-in. pop 0..1 is the arrival's progress: the character rises from 70% with a squash, overshoots to 106%
    // and settles, from the feet. Nothing at 1 (or when unset).
    var pop = o.pop == null || o.pop === false ? 1 : Math.max(0, Math.min(1, Number(o.pop) || 0)), popX = 1, popY = 1;
    if (pop < 1) { var k2 = 1 - Math.pow(1 - pop, 2.4); popY = 0.7 + 0.3 * Math.min(1, k2 / 0.6) + (k2 > 0.6 ? 0.06 * Math.sin((k2 - 0.6) / 0.4 * Math.PI) : 0); popX = 1 + (1 - popY) * 0.5; }
    // wave 13: gaze. o.gaze { x, y } in -1..1 (screen space: +x is to the right, +y is down) turns the eyes toward a point
    // and tilts the head a touch after them. The iris has more room to climb than to drop, so looking down is gentler.
    var gz = o.gaze && typeof o.gaze.x === 'number' ? o.gaze : null;
    if (gz) { var gx = Math.max(-1, Math.min(1, gz.x)) * facing, gy = Math.max(-1, Math.min(1, Number(gz.y) || 0)); p.look = Math.max(-1.3, Math.min(1.3, p.look + gx * 1.3)); p.lookY = gy < 0 ? gy * 2 : gy * 0.5; p.tilt += gx * 3; }
    // wave 12: the build, and an elder's stoop (the head carried forward)
    var B = BUILDS[a.build], bw = B.w, bh = bodyH(a), bhead = B.head;
    if (a.elder) p.lean += 3;
    var skin = C.skin[a.skin], hair = C.hair[a.hairColor], hatC = C.color[a.hatColor], shirt = C.shirt[a.shirt], pants = C.pants[a.pants];
    var pen = new Pen(ctx, s);
    ctx.save();
    // ground shadow (never bobs: the character leaves it when jumping)
    if (o.shadow !== false) { ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.beginPath(); ctx.ellipse(x, y - 1 * s, 22 * s * (1 - p.jump / 40) * popX, 5 * s * popX, 0, 0, Math.PI * 2); ctx.fill(); }
    ctx.translate(x, y - p.jump * s);
    ctx.scale(facing * s * p.sx * popX, s * p.sy * popY);
    ctx.translate(-50, -120);
    // breathing / walking bob moves the whole body
    ctx.translate(0, p.bob);

    var shirtG = pen.grad(30, 70, 70, 112, shade(shirt, 22), shade(shirt, -16));
    var pantsG = pen.grad(30, 100, 70, 120, shade(pants, 14), shade(pants, -14));
    var skinG = pen.grad(25, 15, 75, 70, shade(skin, 14), shade(skin, -12));
    var hairG = pen.grad(25, 5, 75, 50, shade(hair, 26), shade(hair, -18));
    var hatG = pen.grad(25, 0, 75, 40, shade(hatC, 34), shade(hatC, -22));
    var hx = 50, hy = 42 - headRise(a), hr = 29;
    function headXf() { ctx.translate(hx, hy); ctx.scale(bhead, bhead); ctx.translate(-hx, -hy); }

    // back hair (behind the head): long hair sways from the crown, the ponytail swings from its root
    ctx.save(); headXf();
    if (a.hair === 'long') { ctx.save(); ctx.translate(hx, hy - 10); ctx.rotate(p.hair * 0.35 * Math.PI / 180); ctx.translate(-hx, -(hy - 10)); pen.rrect(21, 30, 58, 50, 14, hairG); ctx.restore(); }
    if (a.hair === 'afro') { ctx.save(); ctx.translate(hx, hy); ctx.rotate(p.hair * 0.1 * Math.PI / 180); ctx.translate(-hx, -hy); pen.shape(function (c) { for (var i = 0; i < 14; i++) { var an = -Math.PI * 0.95 + i * (Math.PI * 1.9 / 13), rr = hr + 10 + (i % 2) * 3; var px = hx + Math.cos(an) * rr, py = hy - 6 + Math.sin(an) * rr * 0.92; if (i === 0) c.moveTo(px, py); else c.quadraticCurveTo(hx + Math.cos(an - 0.12) * (rr + 7), hy - 6 + Math.sin(an - 0.12) * (rr + 7) * 0.92, px, py); } }, hairG); ctx.restore(); }
    if (a.hair === 'bun') { ctx.save(); ctx.translate(hx, hy); ctx.rotate(p.hair * 0.4 * Math.PI / 180); ctx.translate(-hx, -hy); pen.circle(hx - 8, hy - hr - 2, 10, hairG); pen.circle(hx - 11, hy - hr - 5, 3.5, shade(hair, 30), true); ctx.restore(); }
    if (a.hair === 'ponytail') { ctx.save(); ctx.translate(70, 30); ctx.rotate(p.hair * Math.PI / 180); ctx.translate(-70, -30); pen.shape(function (c) { c.moveTo(70, 30); c.quadraticCurveTo(92, 36, 86, 66); c.quadraticCurveTo(80, 60, 74, 48); c.quadraticCurveTo(76, 40, 70, 30); }, hairG); ctx.restore(); }
    ctx.restore(); // head frame (back hair)

    // wave 12: the body group (the hood, legs, torso, arms and what the hands hold) is scaled from the feet by the build
    ctx.save(); ctx.translate(50, 120); ctx.scale(bw, bh); ctx.translate(-50, -120);
    if (a.top === 'hoodie') { pen.shape(function (c) { c.moveTo(26, 78); c.quadraticCurveTo(22, 52, 50, 46); c.quadraticCurveTo(78, 52, 74, 78); c.quadraticCurveTo(50, 70, 26, 78); }, pen.grad(26, 46, 74, 78, shade(shirt, 10), shade(shirt, -26))); }
    // legs (hips at 42 and 58, y 98): thigh + shin with a knee, boots on the shin
    function leg(dx, ang, knee) {
      ctx.save(); ctx.translate(50 + dx, 98);
      pen.jointed(ang, 8, knee, 9, 11, pantsG, function (pn) { pn.rrect(-7, 6, 14, 8, 4, '#4A3424'); ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fillRect(-5, 7.5, 7, 1.6); });
      ctx.restore();
    }
    leg(-8, p.legL, p.kneeL); leg(8, p.legR, p.kneeR);

    // torso
    pen.shape(function (c) { c.moveTo(32, 74); c.quadraticCurveTo(50, 68, 68, 74); c.lineTo(72, 100); c.quadraticCurveTo(50, 106, 28, 100); c.closePath(); }, shirtG);
    if (a.vest === 'yes') {
      pen.poly([[33, 75], [43, 72], [45, 100], [31, 100]], VEST); pen.poly([[57, 72], [67, 75], [69, 100], [55, 100]], VEST);
      ctx.fillStyle = '#D7D7D7'; ctx.fillRect(32, 86, 12, 3); ctx.fillRect(56, 86, 12, 3);
      ctx.fillStyle = VESTD; ctx.fillRect(32, 97, 12, 2); ctx.fillRect(56, 97, 12, 2);
    }
    if (a.extra === 'belt') { pen.rrect(29, 96, 42, 6, 2, '#7A4A22'); ctx.fillStyle = '#E0B45A'; ctx.fillRect(46, 97, 8, 4); ctx.fillStyle = '#9AA0A6'; ctx.fillRect(33, 101, 6, 4); ctx.fillStyle = '#7A4A22'; ctx.fillRect(60, 101, 5, 4); }
    // a collar line and the head's shadow on the chest; the hoodie's pouch and strings; the polo's collar and placket
    if (a.top === 'polo') { pen.shape(function (c) { c.moveTo(40, 72); c.lineTo(50, 84); c.lineTo(60, 72); c.lineTo(56, 70); c.lineTo(50, 78); c.lineTo(44, 70); }, shade(shirt, 28)); ctx.fillStyle = shade(shirt, -30); ctx.fillRect(49, 80, 2, 2); ctx.fillRect(49, 85, 2, 2); }
    else if (a.top === 'hoodie') { pen.rrect(38, 90, 24, 11, 4, shade(shirt, -14)); ctx.strokeStyle = '#F5F5F0'; ctx.lineWidth = 1.6; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(46, 76); ctx.lineTo(45, 90); ctx.moveTo(54, 76); ctx.lineTo(55, 90); ctx.stroke(); }
    else { ctx.strokeStyle = 'rgba(0,0,0,.18)'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(44, 74); ctx.lineTo(50, 80); ctx.lineTo(56, 74); ctx.stroke(); }
    ctx.fillStyle = 'rgba(0,0,0,.14)'; ctx.beginPath(); ctx.ellipse(50 + p.lean * 0.4, 73 + p.bob * 0.2, 17, 4.5, 0, 0, Math.PI * 2); ctx.fill();

    // arms: shoulder pivots at (34,78) and (66,78); upper arm 11, forearm 11, a hand (or a fist, or a pointing finger)
    function hand(pn, fist, point) {
      pn.circle(0, 11, fist ? 5.5 : 5, skinG);
      if (fist) { ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(0, 11, 3, Math.PI * 0.2, Math.PI * 0.8); ctx.stroke(); }
      if (point) { ctx.save(); ctx.translate(0, 11); ctx.rotate(-0.1); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, 9); ctx.lineCap = 'round'; ctx.lineWidth = 4 + pn.lw * 2; ctx.strokeStyle = INK; ctx.stroke(); ctx.lineWidth = 4; ctx.strokeStyle = skin; ctx.stroke(); ctx.restore(); }
    }
    function arm(sx, sy, ang, bend, fist, point) {
      ctx.save(); ctx.translate(sx, sy);
      pen.jointed(ang, 11, bend, 11, 9, shirtG, function (pn) { hand(pn, fist, point); });
      ctx.restore();
    }
    // whatever the hand holds sits at the end of the forearm
    function inHand(sx, sy, ang, bend, fn) { ctx.save(); ctx.translate(sx, sy); ctx.rotate(ang * Math.PI / 180); ctx.translate(0, 11); ctx.rotate(bend * Math.PI / 180); ctx.translate(0, 11); ctx.scale(1 / bw, 1 / bh); fn(); ctx.restore(); }
    // the left (back) arm
    arm(34, 78, p.armL, p.elbowL, false, false);
    if (a.clipboard) { inHand(34, 78, p.armL, p.elbowL, function () { pen.rrect(-12, -11, 14, 18, 2, '#B98A4E'); pen.rrect(-10, -8, 10, 13, 1, '#F5F5F0', true); ctx.fillStyle = '#8A8F96'; ctx.fillRect(-8, -12, 6, 3); ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.lineWidth = 1; for (var li = 0; li < 3; li++) { ctx.beginPath(); ctx.moveTo(-8, -5 + li * 3); ctx.lineTo(-2, -5 + li * 3); ctx.stroke(); } }); }
    else if (a.prop !== 'none') inHand(34, 78, p.armL, p.elbowL, function () { prop(a.prop); });
    // wave 7: what the back hand carries, drawn at the hand (y down, the body to +x)
    function prop(k) {
      if (k === 'phone') { pen.rrect(-6, -9, 9, 15, 2, '#2C2C2A'); pen.rrect(-5, -7, 7, 11, 1, '#8EC5FF', true); ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.fillRect(-4, -6, 2, 4); }
      else if (k === 'mug') { pen.circle(3, -1, 4, '#F5F5F0'); pen.circle(3, -1, 1.6, '#C9CDD2', true); pen.rrect(-9, -7, 11, 12, 2, '#F5F5F0'); pen.ellipse(-3.5, -7, 5, 1.6, 0, '#6B4A2B', true); ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-6, -11); ctx.quadraticCurveTo(-4, -13, -6, -15); ctx.moveTo(-2, -11); ctx.quadraticCurveTo(0, -13, -2, -15); ctx.stroke(); }
      else if (k === 'cane') { pen.rrect(-1.5, -8, 3, 30, 1.5, '#8B5A2B'); pen.rrect(-7, -10, 9, 3.5, 1.5, '#8B5A2B'); ctx.fillStyle = '#2C2C2A'; ctx.fillRect(-2, 20, 4, 2.5); }
      else if (k === 'keys') { pen.circle(0, -3, 4.5, '#B4B8BD'); pen.circle(0, -3, 2, '#6F747A', true); pen.rrect(-3, 1, 3.5, 10, 1, '#E0B45A'); pen.rrect(0.5, 1.5, 3, 9, 1, '#B4B8BD'); ctx.fillStyle = INK; ctx.fillRect(-3, 8, 1.5, 1.5); ctx.fillRect(2.5, 7, 1.5, 1.5); }
      else if (k === 'baby') { pen.ellipse(-4, -3, 9.5, 6.5, 0.35, '#F2C6DC'); pen.circle(-10, -7, 4.2, '#F2C6A0'); ctx.fillStyle = INK; ctx.fillRect(-12, -7.5, 1.6, 1); ctx.fillRect(-9, -7.5, 1.6, 1); ctx.fillStyle = BLUSH; ctx.fillRect(-12.5, -5.5, 2, 1.2); ctx.fillRect(-8.5, -5.5, 2, 1.2); ctx.strokeStyle = 'rgba(0,0,0,.18)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-6, -8); ctx.quadraticCurveTo(0, -4, -2, 2); ctx.stroke(); }
      else if (k === 'brush') { pen.rrect(-1.5, -16, 3, 17, 1.5, '#8B5A2B'); pen.rrect(-4.5, 0, 9, 4, 1, '#B4B8BD'); pen.rrect(-4.5, 3.5, 9, 8, 1.5, '#E8E4DA'); ctx.fillStyle = '#BD5728'; ctx.fillRect(-4, 9, 8, 2.5); }
      else if (k === 'umbrella') {
        // the hand frame turns with the arm; square it back up so the canopy sits over the head (body to +x, up is -y)
        ctx.rotate(-(p.armL + p.elbowL) * Math.PI / 180);
        pen.line(0, 2, 18, -58, 2.6 + pen.lw * 0.6, INK); pen.line(0, 2, 18, -58, 2.2, '#2C2C2A'); pen.circle(0, 4, 2.4, '#2C2C2A');
        pen.shape(function (c) { c.moveTo(-24, -58); c.quadraticCurveTo(-18, -92, 18, -96); c.quadraticCurveTo(54, -92, 60, -58); for (var si = 0; si < 6; si++) c.quadraticCurveTo(53 - si * 14, -52, 46 - si * 14, -58); }, '#BD5728');
        ctx.fillStyle = '#DD875F'; [[-10, -60], [18, -94], [46, -60]].forEach(function (pt, i) { ctx.beginPath(); ctx.moveTo(18, -58); if (i === 1) { ctx.lineTo(4, -90); ctx.lineTo(32, -90); } else { ctx.lineTo(pt[0], pt[1]); ctx.lineTo(pt[0] + (i ? -6 : 6), -84); } ctx.closePath(); ctx.fill(); });
        ctx.strokeStyle = 'rgba(0,0,0,.28)'; ctx.lineWidth = 1; [-10, 46].forEach(function (rx) { ctx.beginPath(); ctx.moveTo(18, -58); ctx.lineTo(rx, -60); ctx.stroke(); }); ctx.beginPath(); ctx.moveTo(18, -58); ctx.lineTo(18, -94); ctx.stroke();
        pen.circle(18, -97, 2.2, '#2C2C2A');
      }
      else if (k === 'papers') { pen.rrect(-13, -9, 13, 17, 1, '#EAE6DA'); pen.rrect(-11, -10, 13, 17, 1, '#F5F5F0'); ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.lineWidth = 1; for (var pi = 0; pi < 4; pi++) { ctx.beginPath(); ctx.moveTo(-9, -6 + pi * 3); ctx.lineTo(-1, -6 + pi * 3); ctx.stroke(); } ctx.fillStyle = '#BD5728'; ctx.fillRect(-9, -8, 4, 1.5); }
    }

    ctx.restore(); // body group

    // head: a soft circle with a chin, ears, shading and a highlight
    ctx.save(); ctx.translate(hx, hy); ctx.rotate(p.tilt * Math.PI / 180); ctx.scale(bhead, bhead); ctx.translate(p.lean * 0.4, 0); ctx.translate(-hx, -hy);
    pen.circle(hx - hr + 1, hy + 4, 5, skinG); pen.circle(hx + hr - 1, hy + 4, 5, skinG);
    pen.shape(function (c) { c.moveTo(hx - hr, hy - 4); c.quadraticCurveTo(hx - hr, hy - hr - 2, hx, hy - hr - 2); c.quadraticCurveTo(hx + hr, hy - hr - 2, hx + hr, hy - 4); c.quadraticCurveTo(hx + hr + 1, hy + 26, hx, hy + 31); c.quadraticCurveTo(hx - hr - 1, hy + 26, hx - hr, hy - 4); }, skinG);
    // highlight on the forehead, and the hat brim's shadow across it
    ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.beginPath(); ctx.ellipse(hx - 10, hy - 14, 9, 5, -0.5, 0, Math.PI * 2); ctx.fill();
    if (a.hat === 'hardhat' || a.hat === 'cap') { ctx.fillStyle = 'rgba(0,0,0,.11)'; ctx.beginPath(); ctx.ellipse(hx, hy - 9, hr - 1, a.hat === 'cap' ? 5 : 3.5, 0, 0, Math.PI); ctx.fill(); }
    if (a.elder) { ctx.strokeStyle = 'rgba(0,0,0,.18)'; ctx.lineWidth = 1; [[-16, 20], [16, 20]].forEach(function (w) { ctx.beginPath(); ctx.moveTo(hx + w[0], hy + w[1] - 3); ctx.quadraticCurveTo(hx + w[0] * 1.1, hy + w[1], hx + w[0] * 0.9, hy + w[1] + 4); ctx.stroke(); }); }
    // cheeks
    if (p.mouth !== 'frown') { ctx.fillStyle = BLUSH; [[-19, 12], [19, 12]].forEach(function (b) { ctx.beginPath(); ctx.ellipse(hx + b[0], hy + b[1], 6, 3.5, 0, 0, Math.PI * 2); ctx.fill(); }); }

    // eyes (centres 50±12, hy+4): a white, an iris with a darker rim, a pupil, two catchlights, a lid shadow
    var eyL = hx - 12, eyR = hx + 12, ey = hy + 4, lookX = p.look * 1.5, lookY = p.lookY || 0;
    function roundEye(cx, closed) {
      if (closed) { pen.line(cx - 5, ey + 1, cx + 5, ey + 1, 2.4); return; }
      pen.ellipse(cx, ey, 6, 7.5, 0, WHITE);
      var ir = ctx.createRadialGradient(cx + lookX, ey + 2.5 + lookY, 0.5, cx + lookX, ey + 1.5 + lookY, 5.5); ir.addColorStop(0, '#6A5248'); ir.addColorStop(0.7, '#3A2A26'); ir.addColorStop(1, '#241915');
      ctx.fillStyle = ir; ctx.beginPath(); ctx.ellipse(cx + lookX, ey + 1.5 + lookY, 4, 5.5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1A1210'; ctx.beginPath(); ctx.ellipse(cx + lookX, ey + 2.6 + lookY, 2.3, 2.8, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,.16)'; ctx.beginPath(); ctx.ellipse(cx, ey - 5, 6, 2.6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = WHITE; ctx.beginPath(); ctx.arc(cx - 1.6 + lookX, ey - 1.2 + lookY, 1.9, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + 1.8 + lookX, ey + 3.4 + lookY, 0.9, 0, Math.PI * 2); ctx.fill();
    }
    function happyEye(cx) { ctx.strokeStyle = INK; ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.beginPath(); ctx.arc(cx, ey + 3, 5.5, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke(); }
    function sleepyEye(cx, closed) {
      if (closed) { pen.line(cx - 5, ey + 1, cx + 5, ey + 1, 2.4); return; }
      pen.ellipse(cx, ey + 1, 6, 5, 0, WHITE);
      ctx.fillStyle = '#3A2A26'; ctx.beginPath(); ctx.ellipse(cx + lookX, ey + 2.5 + lookY * 0.6, 3.6, 3.6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = WHITE; ctx.beginPath(); ctx.arc(cx - 1.4 + lookX, ey + 1 + lookY * 0.6, 1.3, 0, Math.PI * 2); ctx.fill();
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

    // front hair (sways a touch with the body)
    var top = hy - hr - 2;
    ctx.save(); ctx.translate(hx, hy); ctx.rotate(p.hair * 0.12 * Math.PI / 180); ctx.translate(-hx, -hy);
    if (a.hair === 'short') { pen.shape(function (c) { c.moveTo(hx - hr - 1, hy - 2); c.quadraticCurveTo(hx - hr - 2, top - 4, hx, top - 5); c.quadraticCurveTo(hx + hr + 2, top - 4, hx + hr + 1, hy - 2); c.quadraticCurveTo(hx + hr - 4, hy - 10, hx + 12, hy - 16); c.quadraticCurveTo(hx, hy - 8, hx - 10, hy - 17); c.quadraticCurveTo(hx - hr + 2, hy - 12, hx - hr - 1, hy - 2); }, hairG); }
    else if (a.hair === 'spiky') { pen.shape(function (c) { c.moveTo(hx - hr - 1, hy - 2); c.lineTo(hx - hr - 6, top - 10); c.lineTo(hx - 16, top - 5); c.lineTo(hx - 10, top - 16); c.lineTo(hx - 3, top - 6); c.lineTo(hx + 4, top - 17); c.lineTo(hx + 10, top - 5); c.lineTo(hx + 20, top - 14); c.lineTo(hx + hr + 1, hy - 2); c.quadraticCurveTo(hx + 12, hy - 14, hx, hy - 12); c.quadraticCurveTo(hx - 12, hy - 14, hx - hr - 1, hy - 2); }, hairG); }
    else if (a.hair === 'long') { pen.shape(function (c) { c.moveTo(hx - hr - 1, hy + 2); c.quadraticCurveTo(hx - hr - 3, top - 4, hx, top - 5); c.quadraticCurveTo(hx + hr + 3, top - 4, hx + hr + 1, hy + 2); c.quadraticCurveTo(hx + hr - 6, hy - 10, hx + 8, hy - 14); c.quadraticCurveTo(hx - 4, hy - 6, hx - 14, hy - 16); c.quadraticCurveTo(hx - hr + 4, hy - 12, hx - hr - 1, hy + 2); }, hairG); }
    else if (a.hair === 'buzz') { pen.shape(function (c) { c.moveTo(hx - hr + 1, hy - 6); c.quadraticCurveTo(hx - hr, top, hx, top - 1); c.quadraticCurveTo(hx + hr, top, hx + hr - 1, hy - 6); c.quadraticCurveTo(hx, hy - 12, hx - hr + 1, hy - 6); }, shade(hair, -14), true); ctx.strokeStyle = INK; ctx.lineWidth = pen.lw * 0.6; ctx.beginPath(); ctx.moveTo(hx - hr + 1, hy - 6); ctx.quadraticCurveTo(hx, hy - 12, hx + hr - 1, hy - 6); ctx.stroke(); }
    else if (a.hair === 'curly') { pen.shape(function (c) { c.moveTo(hx - hr - 2, hy); for (var i = 0; i <= 8; i++) { var ang = Math.PI + i * (Math.PI / 8), r1 = hr + 4; var ex = hx + Math.cos(ang) * r1, ey2 = hy - 4 + Math.sin(ang) * (r1 + 2); var mx = hx + Math.cos(ang - Math.PI / 16) * (r1 + 7), my2 = hy - 4 + Math.sin(ang - Math.PI / 16) * (r1 + 9); if (i) c.quadraticCurveTo(mx, my2, ex, ey2); } c.quadraticCurveTo(hx + 16, hy - 12, hx + 4, hy - 16); c.quadraticCurveTo(hx - 8, hy - 8, hx - 16, hy - 15); c.quadraticCurveTo(hx - hr + 3, hy - 10, hx - hr - 2, hy); }, hairG); }
    else if (a.hair === 'afro') { pen.shape(function (c) { c.moveTo(hx - hr - 1, hy - 4); c.quadraticCurveTo(hx - hr - 2, top - 6, hx, top - 7); c.quadraticCurveTo(hx + hr + 2, top - 6, hx + hr + 1, hy - 4); c.quadraticCurveTo(hx + hr - 6, hy - 12, hx + 6, hy - 15); c.quadraticCurveTo(hx - 6, hy - 9, hx - 14, hy - 16); c.quadraticCurveTo(hx - hr + 2, hy - 12, hx - hr - 1, hy - 4); }, hairG); }
    else if (a.hair === 'bun') { pen.shape(function (c) { c.moveTo(hx - hr - 1, hy - 2); c.quadraticCurveTo(hx - hr - 2, top - 3, hx, top - 4); c.quadraticCurveTo(hx + hr + 2, top - 3, hx + hr + 1, hy - 2); c.quadraticCurveTo(hx + 18, hy - 12, hx + 2, hy - 18); c.quadraticCurveTo(hx - 10, hy - 8, hx - 18, hy - 16); c.quadraticCurveTo(hx - hr + 2, hy - 12, hx - hr - 1, hy - 2); }, hairG); }
    else if (a.hair === 'ponytail') { pen.shape(function (c) { c.moveTo(hx - hr - 1, hy - 2); c.quadraticCurveTo(hx - hr - 2, top - 4, hx, top - 5); c.quadraticCurveTo(hx + hr + 2, top - 4, hx + hr + 1, hy - 2); c.quadraticCurveTo(hx + 20, hy - 12, hx + 6, hy - 20); c.quadraticCurveTo(hx - 6, hy - 10, hx - 16, hy - 18); c.quadraticCurveTo(hx - hr + 2, hy - 12, hx - hr - 1, hy - 2); }, hairG); }
    if (a.hair !== 'bald' && a.hair !== 'buzz') { ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.beginPath(); ctx.ellipse(hx - 12, top + 2, 8, 2.6, -0.3, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();

    // hats (lift a touch on a jump)
    ctx.save(); ctx.translate(0, -p.hat);
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
      pen.circle(hx + p.hair * 0.3, top - 15, 5, shade(hatC, 30));
    }
    ctx.restore();

    // eyewear (over the hair and hat brims)
    if (a.extra === 'glasses') {
      ctx.strokeStyle = '#4A5A6B'; ctx.lineWidth = 2; [eyL, eyR].forEach(function (cx) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(cx - 8.5, ey - 7.5, 17, 15, 4) : ctx.rect(cx - 8.5, ey - 7.5, 17, 15); ctx.stroke(); ctx.fillStyle = 'rgba(156,211,240,.28)'; ctx.fill(); });
      ctx.beginPath(); ctx.moveTo(eyL + 8.5, ey - 1); ctx.lineTo(eyR - 8.5, ey - 1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(eyL - 8.5, ey - 1); ctx.lineTo(hx - hr + 2, ey - 3); ctx.moveTo(eyR + 8.5, ey - 1); ctx.lineTo(hx + hr - 2, ey - 3); ctx.stroke();
    } else if (shades) {
      [eyL, eyR].forEach(function (cx) { pen.rrect(cx - 9, ey - 7, 18, 13, 5, pen.grad(cx - 9, ey - 7, cx + 9, ey + 6, '#3A3F4A', '#0E1116')); ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.beginPath(); ctx.ellipse(cx - 3, ey - 3, 4, 1.6, -0.4, 0, Math.PI * 2); ctx.fill(); });
      pen.line(eyL + 9, ey - 3, eyR - 9, ey - 3, 2.4); pen.line(eyL - 9, ey - 3, hx - hr + 1, ey - 5, 2.4); pen.line(eyR + 9, ey - 3, hx + hr - 1, ey - 5, 2.4);
    }
    // a sweat drop slides down the temple when sad (stays with the head)
    if (p.emote === 'sweat' && !reduce) { var sw = (t % 1400) / 1400; ctx.save(); ctx.translate(hx + hr - 6, hy - 14 + sw * 16); ctx.globalAlpha = sw < 0.8 ? 1 : (1 - sw) * 5; pen.shape(function (c) { c.moveTo(0, -5); c.quadraticCurveTo(4, 1, 0, 4); c.quadraticCurveTo(-4, 1, 0, -5); }, '#8EC5FF'); ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.beginPath(); ctx.arc(-1, 0.5, 1, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
    // wave 15: cold breath. A puff leaves the mouth toward the facing side every 3.2 s and drifts up as it grows and fades.
    var cold = Math.max(0, Math.min(1, Number(o.cold) || 0));
    if (cold && !reduce) { var bc = (t + (o.seed || 0) * 11) % 3200; if (bc < 1100) { var bk = bc / 1100; ctx.save(); ctx.globalAlpha = cold * 0.7 * (bk < 0.15 ? bk / 0.15 : 1 - (bk - 0.15) / 0.85); ctx.fillStyle = '#F6F7F8'; for (var bi = 0; bi < 3; bi++) { var br = (2.6 + bi * 1.3) * (0.6 + bk), bxp = hx + 9 + bk * (15 + bi * 4), byp = my + 1 - bk * (11 + bi * 3) + Math.sin(bk * 6 + bi) * 1.2; ctx.beginPath(); ctx.arc(bxp, byp, br, 0, Math.PI * 2); ctx.fill(); } ctx.restore(); } }
    ctx.restore(); // head

    // the right (front) arm and whatever it holds
    arm(66, 78, p.armR, p.elbowR, p.fist, p.point);
    if (!p.fist && !p.point && (!p.armRUp || p.swing)) {
      inHand(66, 78, p.armR, p.elbowR, function () {
        if (p.swing) { pen.rrect(-2, -2, 4, 24, 2, '#8B5A2B'); pen.rrect(-9, -8, 18, 8, 2, pen.grad(-9, -8, 9, 0, '#B4B8BD', '#6F747A')); return; } // a hammer swings whatever the look holds
        if (a.tool === 'hammer') { pen.rrect(-2, -2, 4, 24, 2, '#8B5A2B'); pen.rrect(-9, -8, 18, 8, 2, pen.grad(-9, -8, 9, 0, '#B4B8BD', '#6F747A')); }
        else if (a.tool === 'tape') { pen.rrect(-7, -3, 14, 13, 4, '#F2C200'); pen.circle(0, 3.5, 3.2, '#2C2C2A', true); ctx.fillStyle = '#E8E4DA'; ctx.fillRect(6, 1, 8, 2.5); }
        else if (a.tool === 'ladder') { ctx.translate(10, -40); pen.rrect(0, 0, 4, 62, 2, '#B4B2A9'); pen.rrect(14, 0, 4, 62, 2, '#B4B2A9'); for (var ry = 6; ry < 60; ry += 9) pen.rrect(2, ry, 14, 3.5, 1.5, '#8F8D86'); }
      });
    }

    // emotes that float free of the head: sparkles on a cheer, thought dots when thinking
    if (p.emote === 'sparkle' && !reduce) {
      for (var si = 0; si < 3; si++) {
        var ph = t / 600 + si * 2.1, sx = hx + Math.cos(ph) * 44, sy = hy - 22 + Math.sin(ph * 1.3) * 14, sr = 2.4 + Math.sin(t / 120 + si) * 1.2;
        ctx.fillStyle = si === 1 ? '#FFD98A' : '#FFF4C2'; ctx.beginPath();
        ctx.moveTo(sx, sy - sr * 2); ctx.quadraticCurveTo(sx, sy, sx + sr * 2, sy); ctx.quadraticCurveTo(sx, sy, sx, sy + sr * 2); ctx.quadraticCurveTo(sx, sy, sx - sr * 2, sy); ctx.quadraticCurveTo(sx, sy, sx, sy - sr * 2); ctx.fill();
      }
    } else if (p.emote === 'dots') {
      var dn = reduce ? 3 : Math.floor((t % 1800) / 600) + 1;
      for (var di = 0; di < 3; di++) { if (di < dn) pen.circle(hx + 36 + di * 7, hy - 30 - di * 5, 2.2 + di * 0.9, '#F6F7F8'); }
    }
    ctx.restore();
  }

  function paintCanvas(canvas, look, o) {
    o = o || {};
    var dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    var rect = o.box || (canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { width: 0, height: 0 });
    var cw = Math.round(rect.width) || canvas.width || 64, ch = Math.round(rect.height) || canvas.height || 64;
    if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) { canvas.width = cw * dpr; canvas.height = ch * dpr; }
    var ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, cw, ch);
    var h = (o.fit || 0.86) * ch, y = ch - (ch - h) / 2 + 2, shadow = o.shadow !== false;
    if (o.crop === 'bust') { var us = (ch - 4) / 100; h = 120 * us; y = 2 + (128 + headRise(normalize(look))) * us; shadow = false; } // hat brim to mid-torso fills the box, whatever the build
    draw(ctx, look, { x: cw / 2, y: y, h: h, t: o.t == null ? 0 : o.t, pose: o.pose, facing: o.facing, shadow: shadow, mood: o.mood, blink: o.blink, seed: o.seed, from: o.from, mix: o.mix, gaze: o.gaze, wind: o.wind, pop: o.pop, cold: o.cold });
  }
  var loops = 0;
  // A loop paints at most 30 times a second and measures its canvas once a second (not every frame: a layout read per
  // frame on every avatar on the page is what a slow phone notices), it cross-fades every pose change, and it stops
  // itself when the canvas leaves the page. A canvas with no box (its tab or panel is hidden) is not painted at all:
  // the loop polls it twice a second until it has one again (wave 5, 2026-10-25: the crew board's rows and Big Dave
  // kept drawing behind the Street tab).
  var paints = 0;
  // wave 13: one passive pointer listener for every loop on the page. A loop turns the character's eyes toward the
  // pointer (or the finger) for four seconds after it last moved, easing in and back out, unless its per-frame options
  // say gaze: false or set a gaze of their own.
  var PTR = { x: 0, y: 0, at: 0 };
  function onPointer(e) { if (e && typeof e.clientX === 'number') { PTR.x = e.clientX; PTR.y = e.clientY; PTR.at = Date.now(); } }
  try { if (!reduce && typeof window.addEventListener === 'function') { window.addEventListener('pointermove', onPointer, { passive: true }); window.addEventListener('pointerdown', onPointer, { passive: true }); } } catch (_) {}
  function gazeAt(box, crop, g) {
    // the head sits near the top of a full-figure box and around 40% down a bust; a pointer two boxes away is a full look
    var hxp = box.left + box.width / 2, hyp = box.top + box.height * (crop === 'bust' ? 0.42 : 0.3);
    var tx = Math.max(-1, Math.min(1, (PTR.x - hxp) / (box.width * 2))), ty = Math.max(-1, Math.min(1, (PTR.y - hyp) / (box.height * 2)));
    g.x += (tx - g.x) * 0.18; g.y += (ty - g.y) * 0.18;
  }
  var POP_MS = 360, POKE_MS = 1200;
  function animate(canvas, look, fn) {
    var alive = true, raf = 0, timer = 0, seed = Math.floor(Math.random() * 3000), last = 0, box = null, measured = 0, tw = {}, gzs = { x: 0, y: 0 }, born = 0;
    if (canvas.__chibiStop) canvas.__chibiStop();
    // wave 14: a tap on the canvas gets a wave back, unless the page already answers taps on it (the game card, the
    // locker and the HUD cheer on their own through __chibiTap) or the first frame's options say poke: false
    if (!canvas.__chibiTap && !canvas.__chibiPoke && typeof canvas.addEventListener === 'function') { canvas.__chibiPoke = function () { if (canvas.__pokeOff) return; canvas.__pokeUntil = Date.now() + POKE_MS; }; canvas.addEventListener('click', canvas.__chibiPoke); }
    function frame() {
      if (!alive) return;
      raf = 0; timer = 0;
      if (canvas.isConnected === false) { stop(); return; }
      var now = Date.now();
      if (!box || now - measured > 1000) { box = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null; measured = now; }
      if (box && !box.width && !box.height) { box = null; timer = setTimeout(frame, 500); return; } // hidden: no paint, poll
      if (!last || now - last >= 32) {
        last = now;
        var o = fn ? (fn(now) || {}) : {}; o.t = now; if (o.seed == null) o.seed = seed; if (box && box.width) o.box = box;
        if (o.poke === false) canvas.__pokeOff = true;
        if (canvas.__pokeUntil > now && !canvas.__chibiTap && (o.pose == null || o.pose === 'idle')) o.pose = 'wave';
        var tp = tween(tw, pick(POSES, o.pose, 'idle'), now); o.pose = tp.pose; o.from = tp.from; o.mix = tp.mix;
        if (!reduce && o.pop == null && o.pop !== false) { if (!born) born = now; if (now - born < POP_MS) o.pop = (now - born) / POP_MS; }
        if (o.gaze == null && !reduce) {
          if (box && box.width && PTR.at && now - PTR.at < 4000 && typeof box.left === 'number') gazeAt(box, o.crop, gzs); else { gzs.x *= 0.88; gzs.y *= 0.88; }
          if (Math.abs(gzs.x) > 0.01 || Math.abs(gzs.y) > 0.01) o.gaze = { x: gzs.x, y: gzs.y };
        }
        paintCanvas(canvas, look, o); paints++;
      }
      if (reduce) { alive = false; return; }
      raf = requestAnimationFrame(frame);
    }
    // stop exists before the first frame: a canvas animated before it is in the DOM used to hit "stop is not a
    // function" on that frame (the crew board's rows, 2026-10-25 wave 5) and the loop died without a trace.
    var stop = function () { if (!alive) return; alive = false; loops--; if (raf) cancelAnimationFrame(raf); if (timer) clearTimeout(timer); if (canvas.__chibiStop === stop) canvas.__chibiStop = null; };
    canvas.__chibiStop = stop;
    loops++;
    frame();
    return stop;
  }

  window.NBDChibi = { draw: draw, paintCanvas: paintCanvas, animate: animate, normalize: normalize, poseOf: poseOf, tween: tween, mixPose: mixPose, POSES: POSES, BUILDS: BUILDS, C: C, reduce: reduce, TWEEN_MS: TWEEN_MS, _pointer: PTR, headRise: headRise, POP_MS: POP_MS, POKE_MS: POKE_MS, _loops: function () { return loops; }, _paints: function () { return paints; } };
})();
