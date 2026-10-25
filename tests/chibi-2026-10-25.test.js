/**
 * tests/chibi-2026-10-25.test.js — the vector chibi (docs/pro/js/chibi.js) that draws every avatar on Roof Rep and the
 * CRM game card since 2026-10-25.
 *
 * Runs the real file against a recording 2D-context stub: every part option, every pose and both facings draw without
 * throwing and with a sensible amount of geometry; poses actually differ; blinking is time-based; reduced motion gives
 * one still frame; a loop stops when its canvas leaves the document; the pages load it ahead of the scripts that use it.
 *
 * Zero deps. Run: node tests/chibi-2026-10-25.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); } }

function makeCtx() {
  const log = { fills: 0, strokes: 0, paths: 0, pts: [], scale: [] };
  const grad = () => ({ addColorStop() {} });
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '', globalAlpha: 1, font: '',
    save() {}, restore() {}, beginPath() { log.paths++; }, closePath() {}, fill() { log.fills++; }, stroke() { log.strokes++; },
    moveTo(x, y) { log.pts.push([x, y]); }, lineTo(x, y) { log.pts.push([x, y]); }, arc(x, y) { log.pts.push([x, y]); }, ellipse(x, y) { log.pts.push([x, y]); },
    arcTo(x, y) { log.pts.push([x, y]); }, quadraticCurveTo(a, b, x, y) { log.pts.push([x, y]); }, bezierCurveTo() {}, rect() {}, roundRect() {},
    fillRect() { log.fills++; }, clearRect() {}, translate() {}, rotate() {}, scale(x, y) { log.scale.push([x, y]); }, setTransform() {},
    createLinearGradient: grad, createRadialGradient: grad,
  };
  return { ctx, log };
}
function load(opts) {
  opts = opts || {};
  const rafs = [];
  const win = {
    devicePixelRatio: opts.dpr || 2,
    matchMedia: () => ({ matches: !!opts.reduce }),
    requestAnimationFrame: (fn) => { rafs.push(fn); return rafs.length; },
    cancelAnimationFrame: () => {},
  };
  const box = { window: win, console, Date, Math, Number, JSON, parseInt, requestAnimationFrame: win.requestAnimationFrame, cancelAnimationFrame: win.cancelAnimationFrame };
  vm.createContext(box);
  vm.runInContext(read('docs/pro/js/chibi.js'), box);
  return { CH: win.NBDChibi, rafs, win };
}

console.log('1. The API');
const { CH } = load();
ok('window.NBDChibi exposes draw, paintCanvas, animate, normalize, poseOf and the pose list', CH && ['draw', 'paintCanvas', 'animate', 'normalize', 'poseOf'].every((k) => typeof CH[k] === 'function') && Array.isArray(CH.POSES));
ok('eight poses: idle, walk, knock, talk, cheer, sad, wave, think', CH.POSES.join(',') === 'idle,walk,knock,talk,cheer,sad,wave,think');
const n = CH.normalize({ skin: 9, hair: 'mohawk', eyes: 'laser', hat: 'crown', vest: 'maybe', mood: 'frown', clipboard: 1 });
ok('normalize falls back on every unknown value and keeps mood and clipboard', n.skin === 1 && n.hair === 'short' && n.eyes === 'round' && n.hat === 'hardhat' && n.vest === 'none' && n.mood === 'frown' && n.clipboard === true);
ok('the palette matches the game card sprite (same six skins, six hair colours, six shirts, four pants)', JSON.stringify(CH.C.skin) === JSON.stringify(['#FBD9C0', '#F2C6A0', '#D99A6C', '#B97A4E', '#8D5A36', '#5E3B23']) && CH.C.shirt.length === 6 && CH.C.pants.length === 4 && CH.C.hair.length === 6);

console.log('\n2. Every part, every pose, both facings draw');
const hairs = ['short', 'spiky', 'long', 'buzz', 'ponytail', 'bald'], eyes = ['round', 'happy', 'wink', 'sleepy'], hats = ['hardhat', 'cap', 'beanie', 'none'];
const beards = ['none', 'stubble', 'mustache', 'full'], tools = ['hammer', 'tape', 'ladder', 'none'], extras = ['none', 'glasses', 'shades', 'belt'];
let combos = 0, err = null, minFills = Infinity;
try {
  hairs.forEach((hair) => hats.forEach((hat) => eyes.forEach((ey) => beards.forEach((beard) => {
    const { ctx, log } = makeCtx();
    CH.draw(ctx, { hair, hat, eyes: ey, beard, vest: 'yes', tool: tools[combos % 4], extra: extras[combos % 4], clipboard: combos % 5 === 0, elder: combos % 7 === 0 }, { x: 50, y: 120, h: 120, t: 1234, pose: CH.POSES[combos % 8], facing: combos % 2 ? -1 : 1 });
    combos++; minFills = Math.min(minFills, log.fills);
  }))));
} catch (e) { err = e; }
ok('6 hair × 4 headwear × 4 eyes × 4 beards (tools, extras, clipboard, elder cycling) draw without throwing', !err && combos === 384, err && err.stack);
ok('every combination fills at least 20 shapes (the character is not partly skipped)', minFills >= 20, 'min ' + minFills);
{
  const { ctx, log } = makeCtx(); CH.draw(ctx, {}, { x: 0, y: 0, h: 60, pose: 'idle', facing: -1 });
  ok('facing -1 mirrors the character through a negative x scale', log.scale.some((s) => s[0] < 0));
}
{
  const { ctx, log } = makeCtx(); CH.draw(ctx, { skin: 1, hair: 'short', hat: 'none' }, { x: 0, y: 0, h: 120, t: 100, pose: 'idle' });
  ok('a bad option object (null look) still draws', (() => { try { CH.draw(makeCtx().ctx, null, {}); return true; } catch (_) { return false; } })());
  ok('a shadow is drawn by default and skipped with shadow:false', (() => { const a = makeCtx(); CH.draw(a.ctx, {}, { h: 60 }); const b = makeCtx(); CH.draw(b.ctx, {}, { h: 60, shadow: false }); return a.log.fills === b.log.fills + 1; })());
}

console.log('\n3. Poses and time');
const P = (pose, t, o) => CH.poseOf(pose, t, o || {});
ok('walk swings the legs against each other and bobs; idle barely moves', Math.abs(P('walk', 150).legL) > 5 && P('walk', 150).legR === -P('walk', 150).legL && Math.abs(P('idle', 150).legL) === 0);
ok('knock raises the front arm into a fist near the head', P('knock', 0).armRUp === 1 && P('knock', 0).fist === true && P('knock', 0).armR < -40);
ok('talk opens and closes the mouth over time', P('talk', 0).mouthOpen !== P('talk', 110).mouthOpen);
ok('cheer lifts both arms, jumps and squashes', P('cheer', 150).armLUp === 1 && P('cheer', 150).armRUp === 1 && P('cheer', 150).jump > 0 && P('cheer', 150).mouth === 'open');
ok('sad frowns with lowered brows; a frowning mood frowns in idle but never in cheer or wave', P('sad', 0).mouth === 'frown' && P('sad', 0).browDown === 1 && P('idle', 0, { mood: 'frown' }).mouth === 'frown' && P('cheer', 0, { mood: 'frown' }).mouth === 'open' && P('wave', 0, { mood: 'frown' }).mouth === 'open');
ok('think brings the hand to the chin and looks away', P('think', 0).armRUp === 1 && P('think', 0).armR < -140 && P('think', 0).look === -1);
ok('a blink lands in the last 150 ms of every 3.6 s cycle and nowhere else', P('idle', 3500).eyesClosed === true && P('idle', 1000).eyesClosed === false && P('idle', 3500, { blink: false }).eyesClosed === false);
ok('an unknown pose draws as idle', (() => { const { ctx, log } = makeCtx(); CH.draw(ctx, {}, { h: 60, pose: 'moonwalk' }); return log.fills >= 28; })());

console.log('\n4. Canvases, loops, reduced motion');
function fakeCanvas(w, h, connected) {
  const c = { width: 0, height: 0, isConnected: connected !== false, getBoundingClientRect: () => ({ width: w, height: h }) };
  const made = makeCtx(); c.getContext = () => made.ctx; c._log = made.log; return c;
}
{
  const cv = fakeCanvas(64, 64); CH.paintCanvas(cv, {}, { pose: 'idle' });
  ok('paintCanvas sizes the bitmap to the CSS box times devicePixelRatio (64 css → 128 px at 2x)', cv.width === 128 && cv.height === 128 && cv._log.fills >= 28);
  const cv2 = fakeCanvas(44, 44); CH.paintCanvas(cv2, {}, { crop: 'bust' });
  const cv2b = fakeCanvas(44, 44); CH.paintCanvas(cv2b, {}, {});
  ok('a bust crop draws the same character minus the ground shadow', cv2._log.fills >= 20 && cv2b._log.fills === cv2._log.fills + 1);
}
{
  const L = load(); const cv = fakeCanvas(64, 64); let calls = 0;
  const stop = L.CH.animate(cv, {}, () => { calls++; return { pose: 'idle' }; });
  ok('animate draws the first frame at once and queues the next one', calls === 1 && L.rafs.length === 1 && L.CH._loops() === 1);
  L.rafs[0](); ok('the next frame draws again', calls === 2);
  cv.isConnected = false; L.rafs[1]();
  ok('a loop ends on its own once the canvas leaves the document', calls === 2 && L.CH._loops() === 0);
  const cv3 = fakeCanvas(64, 64); L.CH.animate(cv3, {}, () => ({})); const s2 = L.CH.animate(cv3, {}, () => ({}));
  ok('a second animate on the same canvas replaces the first (one loop per canvas)', L.CH._loops() === 1); s2();
  ok('stop() ends the loop', L.CH._loops() === 0);
}
{
  const R = load({ reduce: true }); const cv = fakeCanvas(64, 64); let calls = 0;
  R.CH.animate(cv, {}, () => { calls++; return {}; });
  ok('prefers-reduced-motion: one still frame, no requestAnimationFrame, and the walk cycle holds still', calls === 1 && R.rafs.length === 0 && R.CH.reduce === true && R.CH.poseOf('walk', 300, {}).legL === 0);
}

console.log('\n5. The pages');
const rr = read('docs/pro/roof-rep.html'), dash = read('docs/pro/dashboard.html'), rrjs = read('docs/pro/js/pages/roof-rep.js'), gs = read('docs/pro/js/game-sprite.js');
ok('roof-rep.html loads chibi.js before roof-rep-fx.js and roof-rep.js', rr.indexOf('js/chibi.js?v=') > 0 && rr.indexOf('js/chibi.js?v=') < rr.indexOf('roof-rep-fx.js?v=') && rr.indexOf('roof-rep.js?v=3') > 0);
ok('dashboard.html loads chibi.js before game-sprite.js (v2)', dash.indexOf('js/chibi.js?v=') > 0 && dash.indexOf('js/chibi.js?v=') < dash.indexOf('js/game-sprite.js?v=2'));
ok('game-sprite.js draws through the chibi when it is on the page and keeps the 32×32 grid as the fallback', /if \(window\.NBDChibi\) \{ window\.NBDChibi\.animate\(canvas, normalize\(avatar\)/.test(gs) && /_build: build, _outline: outline/.test(gs));
ok('roof-rep.js draws the street rep and the rival through chibi() with a pose, facing and the frame time', /chibi\(g, SAVE\.avatar, Math\.round\(WALK\.px\), Math\.round\(WALK\.py\) - 12, p0, WALK\.face \|\| 1, now\)/.test(rrjs) && /chibi\(g, RIVAL_LOOK, [^;]*rd > 1\.6 \? 'walk' : 'idle'/.test(rrjs));
ok('the street pose is knock while the knock ring shows, walk on a path, and a POSE override (cheer, sad, wave) wins', /p0 = POSE\.until > now \? POSE\.name : KNOCK\.until > now \? 'knock' : walking \? 'walk' : 'idle'/.test(rrjs));
ok('a signed job, a level-up, a trophy and a quest cheer; a lost door slumps; a card left or a booking waves', /FX\.flash\(false\); pose\('cheer'/.test(rrjs) && /sfx\('level'\)[^\n]*pose\('cheer'/.test(rrjs) && /sfx\('trophy'\)[^\n]*pose\('cheer'/.test(rrjs) && /setStatus\(h, 'lost'\); pose\('sad'/.test(rrjs) && /setStatus\(h, 'later'\); pose\('wave'/.test(rrjs) && /setStatus\(h, 'booked'\); pose\('wave'/.test(rrjs));
ok('the speech sheet face talks for 1.8 s then idles, frowning under 35% trust; the HUD and tutorial faces are bust crops, the locker is full body', /drawTo\(faceCv, look, 'talk', meter && meter\.pct < 35 \? 'frown' : undefined\)/.test(rrjs) && /crop = canvas\.id === 'lkPrev' \? undefined : 'bust'/.test(rrjs) && /drawTo\(document\.getElementById\('tutFace'\), FOREMAN, 'talk'\)/.test(rrjs));
ok('the crew board thumbnails are still frames (no loop per row)', /drawStill\(cv, r\.avatar \|\| DEFAULTS\)/.test(rrjs));
const css = read('docs/pro/css/roof-rep.css'), gcss = read('docs/pro/css/game-card.css');
ok('no avatar canvas keeps image-rendering: pixelated (vector now)', !/pixelated/.test(css) && !/pixelated/.test(gcss));
ok('roof-rep.css v4 and game-card.css v4 are what the pages load', /roof-rep\.css\?v=4/.test(rr) && /game-card\.css\?v=4/.test(dash));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
