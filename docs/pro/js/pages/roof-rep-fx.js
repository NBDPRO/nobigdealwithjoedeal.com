/**
 * roof-rep-fx.js — game feel for Roof Rep (2026-10-25 revamp). Loaded before roof-rep.js, which calls window.RoofRepFX.
 *
 * Floating XP / cash text and confetti on the street canvas, a shake or flash on the stage for a bad or good moment, weather
 * particles (rain, snow, wind-blown leaves) and the evening tint. Everything here is cosmetic: no game state, no storage.
 * Honours prefers-reduced-motion (particles still show, nothing shakes or bobs).
 */
(function () {
  'use strict';
  var reduce = false;
  try { reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) {}
  var floats = [], bits = [], wxBits = [], wxKind = null;

  function float(text, x, y, color, big) { floats.push({ t: text, x: x, y: y, c: color || '#f3ede2', life: 1, big: !!big }); }
  function burst(x, y, n, colors) {
    colors = colors || ['#dd875f', '#f2a900', '#7bc96f', '#8ec5ff', '#f3ede2'];
    for (var i = 0; i < (n || 24); i++) bits.push({ x: x, y: y, vx: (Math.random() - .5) * 3.2, vy: -Math.random() * 3 - 1, g: .09, life: 1, c: colors[i % colors.length], r: 1.5 + Math.random() * 1.5 });
  }
  function stage(cls) {
    var el = document.querySelector('.stage'); if (!el || reduce) return;
    el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
    setTimeout(function () { el.classList.remove(cls); }, 600);
  }
  var shake = function () { stage('shake'); };
  var flash = function (bad) { stage(bad ? 'flash-bad' : 'flash'); };

  function weather(ctx, kind, w, h) {
    if (kind !== wxKind) { wxKind = kind; wxBits = []; var n = kind === 'rain' ? 70 : kind === 'snow' ? 45 : kind === 'wind' ? 12 : 0; for (var i = 0; i < n; i++) wxBits.push({ x: Math.random() * w, y: Math.random() * h, s: .6 + Math.random() }); }
    if (!wxBits.length) return;
    ctx.save();
    wxBits.forEach(function (p) {
      if (kind === 'rain') { ctx.strokeStyle = 'rgba(200,220,255,.45)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - 1.5, p.y + 6 * p.s); ctx.stroke(); p.y += 4 * p.s; p.x -= .8; }
      else if (kind === 'snow') { ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.beginPath(); ctx.arc(p.x, p.y, .9 * p.s, 0, 6.3); ctx.fill(); p.y += .5 * p.s; p.x += Math.sin(p.y / 12) * .4; }
      else { ctx.fillStyle = 'rgba(224,180,90,.8)'; ctx.beginPath(); ctx.ellipse(p.x, p.y, 2.2, 1.2, p.y / 9, 0, 6.3); ctx.fill(); p.x += 2.4 * p.s; p.y += Math.sin(p.x / 10) * .6; }
      if (p.y > h) { p.y = -4; p.x = Math.random() * w; } if (p.x > w) { p.x = -4; } if (p.x < -4) { p.x = w; }
    });
    ctx.restore();
  }
  function tint(ctx, min, w, h) {
    // the street warms through the afternoon and dims toward 6 PM
    if (min == null || min < 15 * 60) return;
    var t = Math.min(1, (min - 15 * 60) / 180);
    ctx.fillStyle = 'rgba(255,140,40,' + (0.12 * t) + ')'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(10,20,50,' + (0.22 * t) + ')'; ctx.fillRect(0, 0, w, h);
  }
  function draw(ctx) {
    bits = bits.filter(function (b) { return b.life > 0; });
    bits.forEach(function (b) { b.x += b.vx; b.y += b.vy; b.vy += b.g; b.life -= .022; ctx.globalAlpha = Math.max(0, b.life); ctx.fillStyle = b.c; ctx.fillRect(b.x, b.y, b.r * 2, b.r * 2); });
    floats = floats.filter(function (f) { return f.life > 0; });
    floats.forEach(function (f) {
      f.y -= .55; f.life -= .013;
      ctx.globalAlpha = Math.max(0, Math.min(1, f.life * 1.6));
      ctx.font = (f.big ? '800 13px' : '700 9px') + ' Montserrat, "Segoe UI", sans-serif'; ctx.textAlign = 'center';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(10,14,22,.9)'; ctx.strokeText(f.t, f.x, f.y);
      ctx.fillStyle = f.c; ctx.fillText(f.t, f.x, f.y);
    });
    ctx.globalAlpha = 1;
  }
  var bob = function (walking, t) { return !reduce && walking ? Math.round(Math.sin(t / 90) * 1.5) : 0; };
  window.RoofRepFX = { float: float, burst: burst, shake: shake, flash: flash, weather: weather, tint: tint, draw: draw, bob: bob, reduce: reduce };
})();
