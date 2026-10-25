/**
 * tests/chibi-2026-10-25.test.js — the vector chibi (docs/pro/js/chibi.js) that draws every avatar on Roof Rep and the
 * CRM game card since 2026-10-25.
 *
 * Runs the real file against a recording 2D-context stub: every part option, every pose and both facings draw without
 * throwing and with a sensible amount of geometry; poses actually differ; blinking is time-based; reduced motion gives
 * one still frame; a loop stops when its canvas leaves the document; the pages load it ahead of the scripts that use it.
 * Wave 2 (same day): poses cross-fade (tween / mixPose), limbs bend at the elbow and knee, hair and hats carry secondary
 * motion, emotes, and the point / nod / shrug poses the street and Storm Run use.
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
ok('window.NBDChibi exposes draw, paintCanvas, animate, normalize, poseOf, tween, mixPose and the pose list', CH && ['draw', 'paintCanvas', 'animate', 'normalize', 'poseOf', 'tween', 'mixPose'].every((k) => typeof CH[k] === 'function') && Array.isArray(CH.POSES));
ok('thirteen poses: idle, walk, knock, talk, cheer, sad, wave, think, point, nod, shrug, hammer, climb', CH.POSES.join(',') === 'idle,walk,knock,talk,cheer,sad,wave,think,point,nod,shrug,hammer,climb');
const n = CH.normalize({ skin: 9, hair: 'mohawk', eyes: 'laser', hat: 'crown', vest: 'maybe', mood: 'frown', clipboard: 1 });
ok('normalize falls back on every unknown value and keeps mood and clipboard', n.skin === 1 && n.hair === 'short' && n.eyes === 'round' && n.hat === 'hardhat' && n.vest === 'none' && n.mood === 'frown' && n.clipboard === true);
ok('the palette matches the game card sprite (same six skins, six hair colours, six shirts, four pants)', JSON.stringify(CH.C.skin) === JSON.stringify(['#FBD9C0', '#F2C6A0', '#D99A6C', '#B97A4E', '#8D5A36', '#5E3B23']) && CH.C.shirt.length === 6 && CH.C.pants.length === 4 && CH.C.hair.length === 6);

console.log('\n2. Every part, every pose, both facings draw');
const hairs = ['short', 'spiky', 'long', 'buzz', 'ponytail', 'bald', 'curly', 'afro', 'bun'], eyes = ['round', 'happy', 'wink', 'sleepy'], hats = ['hardhat', 'cap', 'beanie', 'none'];
const beards = ['none', 'stubble', 'mustache', 'full'], tools = ['hammer', 'tape', 'ladder', 'none'], extras = ['none', 'glasses', 'shades', 'belt'];
let combos = 0, err = null, minFills = Infinity;
try {
  hairs.forEach((hair) => hats.forEach((hat) => eyes.forEach((ey) => beards.forEach((beard) => {
    const { ctx, log } = makeCtx();
    CH.draw(ctx, { hair, hat, eyes: ey, beard, vest: combos % 3 ? 'yes' : 'none', top: ['tee', 'hoodie', 'polo'][combos % 3], tool: tools[combos % 4], extra: extras[combos % 4], clipboard: combos % 5 === 0, elder: combos % 7 === 0 }, { x: 50, y: 120, h: 120, t: 1234, pose: CH.POSES[combos % 8], facing: combos % 2 ? -1 : 1 });
    combos++; minFills = Math.min(minFills, log.fills);
  }))));
} catch (e) { err = e; }
ok('9 hair × 4 headwear × 4 eyes × 4 beards (tops, tools, extras, clipboard, elder cycling) draw without throwing', !err && combos === 576, err && err.stack);
ok('normalize knows the wave-4 looks: curly / afro / bun hair and the tee / hoodie / polo top (unknown top falls back to tee)', CH.normalize({ hair: 'afro', top: 'hoodie' }).hair === 'afro' && CH.normalize({ hair: 'bun', top: 'polo' }).top === 'polo' && CH.normalize({ top: 'cape' }).top === 'tee' && CH.normalize({ hair: 'curly' }).hair === 'curly');
ok('a hoodie and a polo draw more than a tee (hood + pouch + strings; collar + placket)', (() => { const t = makeCtx(), h = makeCtx(), p = makeCtx(); CH.draw(t.ctx, { top: 'tee' }, { h: 60 }); CH.draw(h.ctx, { top: 'hoodie' }, { h: 60 }); CH.draw(p.ctx, { top: 'polo' }, { h: 60 }); return h.log.fills > t.log.fills && p.log.fills > t.log.fills; })());
{
  let e2 = null, n2 = 0;
  try { ['point', 'nod', 'shrug', 'think', 'sad', 'cheer'].forEach((p) => ['hammer', 'ladder', 'none'].forEach((tool) => { CH.draw(makeCtx().ctx, { tool, clipboard: true, hair: 'ponytail' }, { h: 90, t: 777, pose: p, from: 'walk', mix: 0.4 }); n2++; })); } catch (e) { e2 = e; }
  ok('every pose also draws mid cross-fade from walk, with a tool, a clipboard and a ponytail', !e2 && n2 === 18, e2 && e2.stack);
}
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
ok('a happy mood closes the eyes into arcs and widens the smile into a grin; sad still wins', P('idle', 0, { mood: 'happy' }).happyEyes === true && P('idle', 0, { mood: 'happy' }).mouth === 'grin' && !P('sad', 0, { mood: 'happy' }).happyEyes);
ok('think raises the arm and bends the elbow so the hand reaches the chin, and looks away', P('think', 0).armRUp === 1 && P('think', 0).armR < -100 && P('think', 0).elbowR < -100 && P('think', 0).look === -1 && P('think', 0).emote === 'dots');
ok('arms and legs are jointed: walk bends the forward elbow and the trailing knee, knock pumps the forearm, wave swings it beside the head', (() => { const w = P('walk', 150); const k0 = P('knock', 0), k1 = P('knock', 70); const v0 = P('wave', 0), v1 = P('wave', 190); return (w.kneeL > 0) !== (w.kneeR > 0) && w.elbowL !== w.elbowR && k0.armR === k1.armR && k0.elbowR !== k1.elbowR && v0.armR === v1.armR && v0.elbowR !== v1.elbowR; })());
ok('point extends the front arm with a finger; nod rocks the head; shrug lifts both forearms out with brows up and a flat mouth', P('point', 0).point === true && P('point', 0).armR < -90 && Math.abs(P('point', 0).elbowR) < 20 && P('nod', 300).tilt !== P('nod', 900).tilt && P('shrug', 0).elbowL > 60 && P('shrug', 0).elbowR < -60 && P('shrug', 0).browUp === 1 && P('shrug', 0).mouth === 'flat');
ok('secondary motion: the walk swings the hair, a cheer lifts the hat and sways the hair, and the walk squashes on the footfall', P('walk', 150).hair !== 0 && P('cheer', 20).hat > 0 && P('cheer', 100).hair !== 0 && P('walk', 0).sy < 1 && P('walk', 0).sx > 1);
ok('hammer winds up and strikes over a 520 ms cycle with the tool kept in hand (swing), and climb steps the legs against each other with both hands up', (() => { const w = P('hammer', 0), st = P('hammer', 300); return w.swing === true && w.armRUp === 1 && st.armR > w.armR && P('climb', 120).armLUp === 1 && P('climb', 120).armRUp === 1 && Math.abs(P('climb', 120).legL) > 2 && P('climb', 120).legR === -P('climb', 120).legL; })());
ok('a hammer pose still draws the hammer even though the arm is up (the swing flag)', (() => { const a = makeCtx(); CH.draw(a.ctx, { tool: 'none' }, { h: 60, pose: 'hammer', t: 100 }); const b = makeCtx(); CH.draw(b.ctx, { tool: 'none' }, { h: 60, pose: 'climb', t: 100 }); return a.log.fills > b.log.fills; })());
ok('emotes: sparkles on a cheer, a sweat drop when sad, thought dots when thinking, none in idle', P('cheer', 0).emote === 'sparkle' && P('sad', 0).emote === 'sweat' && P('think', 0).emote === 'dots' && P('idle', 0).emote === null);
ok('talk varies the mouth like speech (three samples over 400 ms are all different and inside 0..1)', (() => { const a = P('talk', 0).mouthOpen, b = P('talk', 130).mouthOpen, c = P('talk', 400).mouthOpen; return a !== b && b !== c && [a, b, c].every((v) => v >= 0 && v <= 1); })());
{
  const a = P('idle', 0), b = P('cheer', 0), half = CH.mixPose(a, b, 0.5), q = CH.mixPose(a, b, 0.25);
  ok('mixPose interpolates the numbers and switches the shapes half way (mouth is still idle at 25%, cheer at 50%)', Math.abs(half.armR - (a.armR + b.armR) / 2) < 1e-9 && half.mouth === 'open' && q.mouth === 'smile' && q.jump === b.jump * 0.25);
  const st = {}; const t0 = CH.tween(st, 'idle', 1000), t1 = CH.tween(st, 'walk', 1000), t2 = CH.tween(st, 'walk', 1110), t3 = CH.tween(st, 'walk', 1300);
  ok('tween: a pose change fades from the old pose over 220 ms with an ease (mix 0 → 0.5 at the midpoint → 1 and no from once done)', t0.from === undefined && t1.from === 'idle' && t1.mix === 0 && t2.from === 'idle' && Math.abs(t2.mix - 0.5) < 1e-9 && t3.from === undefined && t3.mix === 1 && CH.TWEEN_MS === 220);
  const { ctx, log } = makeCtx(); CH.draw(ctx, {}, { h: 60, pose: 'cheer', from: 'idle', mix: 0.3, t: 50 });
  ok('draw accepts from + mix and still draws the whole character (cheer eyes are strokes, so 20+ fills)', log.fills >= 20);
}
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
  const cvb = fakeCanvas(999, 999); CH.paintCanvas(cvb, {}, { box: { width: 40, height: 40 } });
  ok('a loop can hand paintCanvas a cached box so no layout is read per frame', cvb.width === 80 && cvb.height === 80);
  const cv2 = fakeCanvas(44, 44); CH.paintCanvas(cv2, {}, { crop: 'bust' });
  const cv2b = fakeCanvas(44, 44); CH.paintCanvas(cv2b, {}, {});
  ok('a bust crop draws the same character minus the ground shadow', cv2._log.fills >= 20 && cv2b._log.fills === cv2._log.fills + 1);
}
{
  const L = load(); const cv = fakeCanvas(64, 64); let calls = 0;
  const stop = L.CH.animate(cv, {}, () => { calls++; return { pose: 'idle' }; });
  ok('animate draws the first frame at once and queues the next one', calls === 1 && L.rafs.length === 1 && L.CH._loops() === 1);
  L.rafs[0](); ok('a frame in the same millisecond is skipped (the loop paints at most 30 times a second)', calls === 1);
  { const until = Date.now() + 40; while (Date.now() < until) { /* spin 40 ms */ } }
  L.rafs[1](); ok('a frame 40 ms later draws again', calls === 2);
  cv.isConnected = false; L.rafs[2]();
  ok('a loop ends on its own once the canvas leaves the document', calls === 2 && L.CH._loops() === 0);
  const cv3 = fakeCanvas(64, 64); L.CH.animate(cv3, {}, () => ({})); const s2 = L.CH.animate(cv3, {}, () => ({}));
  ok('a second animate on the same canvas replaces the first (one loop per canvas)', L.CH._loops() === 1); s2();
  {
    const cv4 = fakeCanvas(64, 64); let want = 'idle'; const fillsAt = [];
    const s4 = L.CH.animate(cv4, {}, () => ({ pose: want }));
    fillsAt.push(cv4._log.fills); want = 'cheer';
    const until = Date.now() + 40; while (Date.now() < until) { /* spin */ }
    L.rafs[L.rafs.length - 1](); fillsAt.push(cv4._log.fills); s4();
    ok('animate cross-fades a pose change inside the loop (the frame after a switch still draws the whole character)', fillsAt[1] > fillsAt[0]);
  }
  ok('stop() ends the loop', L.CH._loops() === 0);
}
{
  const R = load({ reduce: true }); const cv = fakeCanvas(64, 64); let calls = 0;
  R.CH.animate(cv, {}, () => { calls++; return {}; });
  ok('prefers-reduced-motion: one still frame, no requestAnimationFrame, and the walk cycle holds still', calls === 1 && R.rafs.length === 0 && R.CH.reduce === true && R.CH.poseOf('walk', 300, {}).legL === 0);
  const rs = {}; R.CH.tween(rs, 'idle', 0); const rt = R.CH.tween(rs, 'walk', 1);
  ok('prefers-reduced-motion: pose changes snap (no cross-fade)', rt.mix === 1 && rt.from === undefined);
}

console.log('\n5. The pages');
const rr = read('docs/pro/roof-rep.html'), dash = read('docs/pro/dashboard.html'), rrjs = read('docs/pro/js/pages/roof-rep.js'), gs = read('docs/pro/js/game-sprite.js');
ok('roof-rep.html loads chibi.js v5 before roof-rep-fx.js and roof-rep.js v7', rr.indexOf('js/chibi.js?v=5') > 0 && rr.indexOf('js/chibi.js?v=5') < rr.indexOf('roof-rep-fx.js?v=') && rr.indexOf('roof-rep.js?v=7') > 0);
ok('dashboard.html loads chibi.js v5 before game-sprite.js (v4)', dash.indexOf('js/chibi.js?v=5') > 0 && dash.indexOf('js/chibi.js?v=5') < dash.indexOf('js/game-sprite.js?v=4'));
ok('wave 5: animate() defines stop before its first frame (a detached canvas stops cleanly instead of throwing)', (function () { var js = read('docs/pro/js/chibi.js'); var a = js.indexOf('var stop = function () { if (!alive) return; alive = false; loops--;'); var f = js.indexOf('loops++;\n    frame();'); return a > 0 && f > 0 && a < f; })());
ok('wave 5: a crew row starts its loop only once the row is on the page', /if \(cv\.__live\) cv\.__live\(\);/.test(rrjs) && rrjs.indexOf('body.appendChild(tr);') < rrjs.indexOf('if (cv.__live) cv.__live();'));
ok('game-sprite.js draws through the chibi when it is on the page (a wave every 14 s, a cheer on tap, one listener per canvas) and keeps the 32×32 grid as the fallback', /window\.NBDChibi\.animate\(canvas, normalize\(avatar\), function \(t\) \{ return \{ pose: canvas\.__cheerUntil > t \? 'cheer' : t % 14000 < 1600 \? 'wave' : 'idle' \}; \}\)/.test(gs) && /if \(!canvas\.__chibiTap\) \{ canvas\.__chibiTap = true; canvas\.addEventListener\('click'/.test(gs) && /_build: build, _outline: outline/.test(gs));
ok('the Roof Rep HUD face and locker preview cheer when tapped (one listener per canvas, on the same loop)', /canvas\.id === 'meFace' \|\| canvas\.id === 'lkPrev'\)\) \{ canvas\.__chibiTap = true; canvas\.addEventListener\('click'/.test(rrjs) && /if \(canvas\.__cheerUntil > now\) pz = 'cheer';/.test(rrjs));
ok('roof-rep.js draws the street rep and the rival through chibi() with a pose, facing, the frame time and a tween key so pose changes cross-fade', /chibi\(g, SAVE\.avatar, Math\.round\(WALK\.px\), Math\.round\(WALK\.py\) - 12, p0, WALK\.face \|\| 1, now, 0, 0, 'rep'\)/.test(rrjs) && /chibi\(g, RIVAL_LOOK, [^;]*rd > 1\.6 \? 'walk' : 'idle'[^;]*'rival'\)/.test(rrjs) && /var tw = key \? CH\.tween\(TWEENS\[key\] \|\| \(TWEENS\[key\] = \{\}\), p, t\) : null/.test(rrjs));
ok('the street pose is knock while the knock ring shows, walk on a path, and a POSE override (cheer, sad, wave) wins', /p0 = POSE\.until > now \? POSE\.name : KNOCK\.until > now \? 'knock' : walking \? 'walk' : 'idle'/.test(rrjs));
ok('a signed job, a level-up, a trophy and a quest cheer; a lost door slumps; a card left or a booking waves', /FX\.flash\(false\); pose\('cheer'/.test(rrjs) && /sfx\('level'\)[^\n]*pose\('cheer'/.test(rrjs) && /sfx\('trophy'\)[^\n]*pose\('cheer'/.test(rrjs) && /setStatus\(h, 'lost'\); pose\('sad'/.test(rrjs) && /setStatus\(h, 'later'\); pose\('wave'/.test(rrjs) && /setStatus\(h, 'booked'\); pose\('wave'/.test(rrjs));
ok('the speech sheet face talks for 1.8 s then idles, frowning under 35% trust and grinning from 70%; the HUD and tutorial faces are bust crops, the locker and level-up card are full body', /meter\.pct < 35 \? 'frown' : meter\.pct >= 70 \? 'happy' : undefined/.test(rrjs) && /drawTo\(faceCv, look, 'talk', mood\)/.test(rrjs) && /crop = canvas\.id === 'lkPrev' \|\| canvas\.id === 'lvlFace' \? undefined : 'bust'/.test(rrjs) && /drawTo\(document\.getElementById\('tutFace'\), FOREMAN, 'talk'\)/.test(rrjs));
ok('Storm Run: a different homeowner says each objection and reacts to the answer (cheer on best, slump on a trap, a nod otherwise)', /drawTo\(document\.getElementById\('runFace'\), who, 'talk'/.test(rrjs) && /drawTo\(rf, who, a\.kind === 'best' \? 'cheer' : a\.kind === 'trap' \? 'sad' : 'nod'/.test(rrjs));
ok('the rep points up at the roof when a homeowner lets them inspect, and the doorway homeowner shrugs at a lost door', /if \(end === 'inspect'\) \{ pose\('point', 1400\);/.test(rrjs) && /setStatus\(h, 'lost'\); pose\('sad', 1800\); if \(DOOR\) DOOR\.pose = 'shrug';/.test(rrjs));
ok('the door swings open over 240 ms (eased leaf, the light fades in) and the homeowner steps up from 70% as it opens; the swing runs once per door, not per line', /var dk = DOOR && DOOR\.h === h \? \(DOOR\.since \? Math\.min\(1, \(Date\.now\(\) - DOOR\.since\) \/ 240\) : 1\) : Math\.max\(0, Math\.min\(1, \(leaveEnd\(LEAVE\) - Date\.now\(\)\) \/ 240\)\); dk = dk \* \(2 - dk\);/.test(rrjs) && /var lx = h\.x \+ 34 - 4 \* dk, lw = 12 - 7 \* dk;/.test(rrjs) && /22 \* \(0\.7 \+ 0\.3 \* dk2\), DOOR\.mood, 'door'\)/.test(rrjs) && /since: wasOpen \|\| Date\.now\(\)/.test(rrjs));
ok('mini-game scenes animate on sceneLoop (same stop hook as the chibi loops): the build has Big Dave pointing and a roofer hammering on the deck (both cheer at the ridge cap), the nailing roofer swings on every tap, the rep sizes up the ladder and cheers or slumps with the answer', /function sceneLoop\(cv, paint\)/.test(rrjs) && /cv\.__chibiStop = stop; frame\(\); return stop;/.test(rrjs) && /tf = CH\.tween\(BUILD_TW\.fore, full \? 'cheer' : 'point', t\), tc = CH\.tween\(BUILD_TW\.crew, full \? 'cheer' : done \? 'hammer' : 'idle', t\)/.test(rrjs) && /swingUntil = Date\.now\(\) \+ 420;/.test(rrjs) && /np = CH\.tween\(nailTw, swingUntil > nt \? 'hammer' : 'idle', nt\)/.test(rrjs) && /LADDER_POSE = feet == null \? 'think' : feet === 4 \? 'cheer' : 'sad';/.test(rrjs) && !/Press Start 2P/.test(rrjs));
ok('the street homeowners draw from the wave-4 looks too (curly / afro / bun, a tee / hoodie / polo)', /pick\(\['short', 'long', 'buzz', 'ponytail', 'bald', 'short', 'long', 'curly', 'afro', 'bun'\]\)/.test(rrjs) && /top: pick\(\['tee', 'tee', 'hoodie', 'polo'\]\)/.test(rrjs));
ok('wave 5: the top 8 crew board rows breathe (idle, blink; the leader cheers every 9 s; a tap cheers), the rest stay still frames', /if \(CH && i < 8\)/.test(rrjs) && /lead && now % 9000 < 1400/.test(rrjs) && /else drawStill\(cv, r\.avatar \|\| DEFAULTS\)/.test(rrjs));
ok('wave 5: Big Dave stands in the Training Yard card (points every 7 s, cheers when tapped)', /id="trainDave"/.test(rrjs) && /CH\.animate\(dave, FOREMAN, function \(now\)/.test(rrjs) && /now % 7000 < 1400 \? 'point'/.test(rrjs) && /\.train-hd \{ display: flex/.test(read('docs/pro/css/roof-rep.css')));
ok('wave 5: homeowners leave the doorway on their own terms: a signed one steps out to the rep and cheers, a lost one shrugs, the rest wave, and the door swings shut after (LEAVE scene)', /var LEAVE = null;/.test(rrjs) && /DOOR\.out = true;/.test(rrjs) && /LEAVE = \{ look: DOOR\.look, h: DOOR\.h/.test(rrjs) && /e < 450\b/.test(rrjs) && /'cheer' : 'walk'/.test(rrjs) === false && /p = 'walk'/.test(rrjs) && /\(LEAVE && LEAVE\.h === h\)/.test(rrjs));
ok('wave 5: the drive spawns no car over the lot column and none nose to tail', /car\.x < 196 && car\.x \+ car\.w > 124\) car\.x \+= 72/.test(rrjs) && /cars\[q\]\.x = cars\[q - 1\]\.x \+ cars\[q - 1\]\.w \+ 14/.test(rrjs));
ok('wave 5: the drive eases the truck between lanes, tilts it into a lateral move, and puffs exhaust and skid dust', /D\.x \+= \(T\.x - D\.x\) \* 0\.35/.test(rrjs) && /c\.rotate\(D\.tilt\)/.test(rrjs) && /function puff\(/.test(rrjs) && /puffs = puffs\.filter/.test(rrjs));
ok('a sheet with nobody talking shows a scene in the face box (the wagging dog, the closed door, the pickup) on the chibi stop hook, and say() keeps DOOR for real homeowners only', /function faceScene\(kind\)/.test(rrjs) && /faceCv\.__chibiStop = stop; paint\(\);/.test(rrjs) && /if \(typeof look === 'string'\) faceScene\(look\);/.test(rrjs) && /say\('dog', 'A big dog'/.test(rrjs) && /say\('door', 'Nobody home'/.test(rrjs) && (rrjs.match(/say\('truck', curStreet\(\)\.name/g) || []).length === 2 && /var next = look && typeof look === 'object' && WALK\.target/.test(rrjs) && /DOOR = next;/.test(rrjs));
const css = read('docs/pro/css/roof-rep.css'), gcss = read('docs/pro/css/game-card.css');
ok('no avatar canvas keeps image-rendering: pixelated (vector now)', !/pixelated/.test(css) && !/pixelated/.test(gcss));
ok('roof-rep.css v5 and game-card.css v4 are what the pages load', /roof-rep\.css\?v=5/.test(rr) && /game-card\.css\?v=4/.test(dash));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
