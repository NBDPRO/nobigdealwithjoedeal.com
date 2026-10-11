/**
 * tests/my-skin-per-theme-2026-10.test.js — My Skin per-theme backgrounds.
 *
 *   1. my-skin-logic.js: schema-2 normalisation (v1 stays v1), clamps and
 *      caps, which background paints for a theme, the trusted-path guards,
 *      the readability guard, per-layer css vars, image ids
 *   2. storage.rules: skins/{uid}/themes/{themeId}/{imageId} is owner-only,
 *      id-shaped, lossy-only, under 3MB (the emulator cases live in
 *      storage-rules.test.js); firestore.rules bounds mySkin.themes
 *   3. my-skin.js contract: per-theme privacy (no token URL, getBlob, uid-keyed
 *      cache), the themechange listener, decode-before-swap, dotted-path writes
 *   4. CSS gating, panel markup, sign-out wiring, the Custom Builder key
 *
 * Run: node tests/my-skin-per-theme-2026-10.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const L = require(path.join(ROOT, 'docs/pro/js/my-skin-logic.js'));
const UID = 'u1';
const img = (id, theme, extra) => Object.assign({ id: id, path: 'skins/' + UID + '/themes/' + (theme || 'pokemon') + '/' + id, v: 5, w: 2560, h: 1440, lum: 0.4, lumCenter: 0.4, avg: '#556677', type: 'image/webp', bytes: 400000 }, extra || {});

console.log('\n1. my-skin-logic: schema 2');
{
  const v1 = L.normalize({ enabled: true, dim: 0.5, slots: { wallpaper: { path: 'skins/u1/wallpaper', v: 3 } } });
  ok('a schema-1 doc comes back per-theme OFF with no themes (paints exactly as before)',
    v1.perTheme === false && Object.keys(v1.themes).length === 0 && v1.allThemes === null && v1.enabled === true && v1.slots.wallpaper.v === 3);
  ok('show defaults: 5m, in order, 0.8s, pause when hidden',
    v1.show.interval === '5m' && v1.show.shuffle === false && v1.show.fadeMs === 800 && v1.show.pauseHidden === true);
  ok('existing fields keep their clamps', L.normalize({ dim: 9 }).dim === L.DIM_MAX && L.normalize({ dim: 'x' }).dim === L.DIM_DEFAULT);

  const n = L.normalize({
    perTheme: true,
    show: { interval: 'hourly', shuffle: 'yes', fadeMs: 99999 },
    themes: {
      pokemon: { images: [img('lq3x9a1b2c')], dim: 9, blur: 99, fit: 'stretch', position: '120% 5%', interval: '1m', shuffle: true, fadeMs: -5 },
      'ben-10': { images: [img('lq3x9a1b2d', 'ben-10')], dim: null, position: '30% 70%' },
      _custom: { images: [img('lq3x9a1b2e', '_custom')] },
      'Bad Id': { images: [img('lq3x9a1b2f')] },
      '../x': { images: [img('lq3x9a1b2f')] },
      empty: { images: [] },
      junk: 'nope',
    },
  });
  ok('unknown interval falls back; shuffle must be a literal true; fade clamps to 0..3000',
    n.show.interval === '5m' && n.show.shuffle === false && n.show.fadeMs === 3000);
  ok('per-theme dim clamps to 0.85, blur to 12, bad fit → cover, bad position → center',
    n.themes.pokemon.dim === L.DIM_MAX && n.themes.pokemon.blur === 12 && n.themes.pokemon.fit === 'cover' && n.themes.pokemon.position === 'center');
  ok('a valid "x% y%" focal point is kept', n.themes['ben-10'].position === '30% 70%');
  ok('per-theme dim null stays null (inherit); interval/shuffle/fadeMs overrides kept or clamped',
    n.themes['ben-10'].dim === null && n.themes.pokemon.interval === '1m' && n.themes.pokemon.shuffle === true && n.themes.pokemon.fadeMs === 0);
  ok('entries with bad ids, no images or junk values are dropped; _custom is kept',
    Object.keys(n.themes).sort().join() === '_custom,ben-10,pokemon');

  const many = {};
  for (let i = 0; i < 260; i++) many['t' + i] = { images: [img('lq3x9a1b2c', 't' + i)] };
  ok('at most 220 theme entries survive', Object.keys(L.normalize({ themes: many }).themes).length === 220);
  const imgs = [];
  for (let i = 0; i < 9; i++) imgs.push(img('lq3x9a' + (10 + i) + 'bc'));
  ok('at most 6 images per theme', L.normalize({ themes: { pokemon: { images: imgs } } }).themes.pokemon.images.length === 6);
  const bad = L.normalize({ themes: { pokemon: { images: [
    img('SHORT'), img('lq3x9a1b2c', 'pokemon', { path: 'photos/u1/x.jpg' }), img('lq3x9a1b2d', 'pokemon', { path: 'skins/u1/themes/../lq3x9a1b2d' }), img('lq3x9a1b2e'),
  ] } } });
  ok('images with a bad id or a path outside skins/*/themes/ are dropped', bad.themes.pokemon.images.length === 1 && bad.themes.pokemon.images[0].id === 'lq3x9a1b2e');
  ok('all-themes ref must be <themeId>/<imageId>',
    L.normalize({ allThemes: { imageRef: 'pokemon/lq3x9a1b2c', dim: 0.4 } }).allThemes.imageRef === 'pokemon/lq3x9a1b2c'
    && L.normalize({ allThemes: { imageRef: '../x' } }).allThemes === null && L.normalize({ allThemes: 'pokemon/lq3x9a1b2c' }).allThemes === null);
  ok('lum stats are clamped to 0..1 and a non-hex average is dropped',
    L.normalize({ themes: { a: { images: [img('lq3x9a1b2c', 'a', { lum: 7, lumCenter: -1, avg: 'red' })] } } }).themes.a.images[0].lum === 1
    && L.normalize({ themes: { a: { images: [img('lq3x9a1b2c', 'a', { avg: 'red' })] } } }).themes.a.images[0].avg === null);
}

console.log('\n2. my-skin-logic: what paints');
{
  const base = { enabled: true, perTheme: true, dim: 0.5, slots: {}, themes: { pokemon: { images: [img('lq3x9a1b2c')], dim: 0.7, blur: 3, hideOverlay: null } } };
  const c = L.normalize(base);
  const r = L.resolveBackground(c, 'pokemon');
  ok('a theme with pictures paints them, with its own dim and blur', r.source === 'theme' && r.images.length === 1 && r.dim === 0.7 && r.blur === 3);
  ok('a picture hides the theme\'s animated overlay by default', r.hideOverlay === true);
  ok('hideOverlay:false keeps the animation',
    L.resolveBackground(L.normalize(Object.assign({}, base, { themes: { pokemon: Object.assign({}, base.themes.pokemon, { hideOverlay: false }) } })), 'pokemon').hideOverlay === false);
  ok('a theme with no entry and nothing else paints nothing (its built-in look)', L.resolveBackground(c, 'batman').source === 'none');

  const withAll = L.normalize(Object.assign({}, base, { allThemes: { imageRef: 'pokemon/lq3x9a1b2c' } }));
  ok('no entry → "use for all themes"', L.resolveBackground(withAll, 'batman').source === 'all' && L.resolveBackground(withAll, 'batman').images[0].id === 'lq3x9a1b2c');
  ok('a theme entry beats "all"', L.resolveBackground(withAll, 'pokemon').source === 'theme');

  const withGlobal = L.normalize(Object.assign({}, base, { allThemes: null, slots: { wallpaper: { path: 'skins/u1/wallpaper', v: 1 } } }));
  const g = L.resolveBackground(withGlobal, 'batman');
  ok('no entry, no all → the global wallpaper, at the global dim', g.source === 'global' && g.dim === 0.5 && g.images.length === 0 && g.hideOverlay === false);
  ok('all beats global',
    L.resolveBackground(L.normalize(Object.assign({}, base, { allThemes: { imageRef: 'pokemon/lq3x9a1b2c' }, slots: { wallpaper: { path: 'skins/u1/wallpaper', v: 1 } } })), 'batman').source === 'all');
  ok('perTheme OFF ignores every per-theme entry (today\'s behaviour)',
    L.resolveBackground(L.normalize(Object.assign({}, base, { perTheme: false, slots: { wallpaper: { path: 'skins/u1/wallpaper', v: 1 } } })), 'pokemon').source === 'global'
    && L.resolveBackground(L.normalize(Object.assign({}, base, { perTheme: false })), 'pokemon').source === 'none');
  ok('My Skin off paints nothing personal, whatever is stored',
    L.resolveBackground(L.normalize(Object.assign({}, base, { enabled: false })), 'pokemon').source === 'none');
  ok('a dangling "all" ref (host theme cleared) falls through to global',
    L.resolveBackground(L.normalize({ enabled: true, perTheme: true, allThemes: { imageRef: 'gone/lq3x9a1b2c' }, slots: { wallpaper: { path: 'skins/u1/wallpaper', v: 1 } } }), 'batman').source === 'global');
  ok('a locked/unknown/orphan id resolves like any other (the engine reports the applied theme)',
    L.resolveBackground(c, 'dragon-ball-super').source === 'none' && L.resolveBackground(c, null).source === 'none' && L.resolveBackground(c, '_custom').source === 'none');
  ok('inherits the global slideshow defaults when the theme says nothing',
    r.interval === '5m' && r.shuffle === false && r.fadeMs === 800);
  ok('raw (un-normalised) configs are accepted', L.resolveBackground(base, 'pokemon').source === 'theme');
}

console.log('\n3. my-skin-logic: trusted paths, ids, reference counting');
{
  const cfg = L.normalize({ themes: {
    pokemon: { images: [img('lq3x9a1b2c')] },
    evil: { images: [{ id: 'lq3x9a1b2d', path: 'skins/OTHER/themes/evil/lq3x9a1b2d', v: 1 }] },
  } });
  ok('themeStoragePath builds skins/{uid}/themes/{themeId}/{imageId}', L.themeStoragePath('u1', 'pokemon', 'lq3x9a1b2c') === 'skins/u1/themes/pokemon/lq3x9a1b2c');
  ok('themeStoragePath refuses bad ids and path-y uids',
    L.themeStoragePath('u1', 'Poke', 'lq3x9a1b2c') === null && L.themeStoragePath('u1', 'pokemon', 'ab') === null
    && L.themeStoragePath('u1', '../x', 'lq3x9a1b2c') === null && L.themeStoragePath('a/b', 'pokemon', 'lq3x9a1b2c') === null
    && L.themeStoragePath('', 'pokemon', 'lq3x9a1b2c') === null && L.themeStoragePath('u1', 'pokemon', 'lq3x9a1b2c_t') === null);
  ok('trustedThemePath accepts only the caller\'s own theme path',
    L.trustedThemePath(cfg, 'u1', 'pokemon', 'lq3x9a1b2c') === 'skins/u1/themes/pokemon/lq3x9a1b2c'
    && L.trustedThemePath(cfg, 'u2', 'pokemon', 'lq3x9a1b2c') === null);
  ok('trustedThemePath refuses a doc edited to point at someone else\'s file', L.trustedThemePath(cfg, 'u1', 'evil', 'lq3x9a1b2d') === null);
  ok('trustedThemePath refuses an unlisted image id', L.trustedThemePath(cfg, 'u1', 'pokemon', 'zzzzzzzzzz') === null);
  ok('trustedImagePath: own prefix only (uid-checked), any theme folder (refs)',
    L.trustedImagePath('u1', { path: 'skins/u1/themes/pokemon/lq3x9a1b2c' }) === 'skins/u1/themes/pokemon/lq3x9a1b2c'
    && L.trustedImagePath('u1', { path: 'skins/u2/themes/pokemon/lq3x9a1b2c' }) === null
    && L.trustedImagePath('u1', { path: 'skins/u1/wallpaper' }) === null
    && L.trustedImagePath('u1', { path: 'skins/u1/themes/pokemon/../../../x' }) === null
    && L.trustedImagePath('u1', null) === null);
  ok('mintImageId: 8..16 chars of [a-z0-9], and it differs per call',
    L.IMAGE_ID_RE.test(L.mintImageId(Date.now())) && L.mintImageId(1, () => 0.1) !== L.mintImageId(1, () => 0.9));

  const rc = L.referencedPaths(L.normalize({
    themes: { pokemon: { images: [img('lq3x9a1b2c')] }, mario: { images: [img('lq3x9a1b2d', 'mario')] } },
    allThemes: { imageRef: 'pokemon/lq3x9a1b2c' },
  }));
  ok('referencedPaths counts theme entries and the all-themes ref',
    rc['skins/u1/themes/pokemon/lq3x9a1b2c'] === 2 && rc['skins/u1/themes/mario/lq3x9a1b2d'] === 1);
}

console.log('\n4. my-skin-logic: readability guard');
{
  const dark = { mode: 'dark', bg: '#0a0c0f', t: '#e8eaf0', m: '#9aa3b2' };
  const light = { mode: 'light', bg: '#f6f4ef', t: '#1a1a1a', m: '#555555' };
  const slot = (o) => Object.assign({ dim: 0.55, blur: 0, dimOverride: false }, o || {});
  const dull = { lumCenter: 0.2, avg: '#202020' };
  ok('a dim picture on a dark theme: the user\'s dim is used as is', L.effectiveDim(slot(), dull, dark).dim === 0.55 && !L.effectiveDim(slot(), dull, dark).raised);
  const bright = { lumCenter: 0.8, avg: '#e0e0e0' };
  const eb = L.effectiveDim(slot({ dim: 0.3 }), bright, dark);
  ok('a bright picture on a dark theme raises the floor (0.55 + (0.8-0.45)*0.6, capped 0.8)', eb.floor === 0.76 && eb.dim >= 0.76 && eb.raised);
  ok('the floor is capped at 0.8', L.effectiveDim(slot({ dim: 0.1 }), { lumCenter: 1, avg: '#ffffff' }, dark).floor === 0.8);
  ok('"I understand" keeps the user\'s dim below the floor and flags it',
    (function () { const e = L.effectiveDim(slot({ dim: 0.3, dimOverride: true }), bright, dark); return e.dim === 0.3 && e.belowFloor === true; })());
  const el = L.effectiveDim(slot({ dim: 0.4 }), { lumCenter: 0.2, avg: '#101010' }, light);
  ok('a dark picture under a light veil: floor 0.72 when the centre is dark', el.floor === 0.72 && el.dim >= 0.72);
  ok('a mid picture under a light veil: floor 0.65', L.effectiveDim(slot({ dim: 0.4 }), { lumCenter: 0.4, avg: '#808080' }, light).floor === 0.65);
  ok('a bright picture under a light veil needs no floor', L.effectiveDim(slot({ dim: 0.4 }), { lumCenter: 0.8, avg: '#f0f0f0' }, light).floor === 0);
  ok('the slider can always go ABOVE the floor', L.effectiveDim(slot({ dim: 0.85 }), bright, dark).dim === 0.85);

  // contrast: white-ish text over a bright average colour needs a stronger veil.
  const e1 = L.effectiveDim(slot({ dim: 0.1 }), { lumCenter: 0.3, avg: '#ffffff' }, dark);
  const comp = L.mixHex(dark.bg, '#ffffff', e1.dim);
  ok('contrast step: the composite behind text reaches 4.5:1', L.contrast(dark.t, comp) >= 4.5 && e1.raised && e1.dim <= L.DIM_MAX);
  ok('contrast step never exceeds the 0.85 maximum', L.effectiveDim(slot({ dim: 0 }), { lumCenter: 0.3, avg: '#ffffff' }, { mode: 'dark', bg: '#ffffff', t: '#ffffff', m: '#ffffff' }).dim <= 0.85);
  ok('prefers-contrast: more forces dim >= 0.8 and blur >= 4',
    (function () { const e = L.effectiveDim(slot({ dim: 0.2 }), dull, Object.assign({ highContrast: true }, dark)); return e.dim >= 0.8 && e.blur >= 4; })());
  ok('blur is capped at 6 on a phone, 12 elsewhere',
    L.effectiveDim(slot({ blur: 12 }), dull, Object.assign({ narrow: true }, dark)).blur === 6 && L.effectiveDim(slot({ blur: 12 }), dull, dark).blur === 12);
  ok('no stats (a global wallpaper) → the plain dim, nothing raised', L.effectiveDim(slot(), null, dark).dim === 0.55);

  ok('toHex: #rgb, rgb(), rgba opaque; refuses translucent and junk',
    L.toHex('#abc') === '#aabbcc' && L.toHex('rgb(10, 20, 30)') === '#0a141e' && L.toHex('rgba(10,20,30,1)') === '#0a141e'
    && L.toHex('rgba(10,20,30,.5)') === null && L.toHex('var(--x)') === null && L.toHex(null) === null);
}

console.log('\n5. my-skin-logic: layer vars + classes');
{
  const eff = { dim: 0.6, blur: 4 };
  const v = L.layerVars({ position: 'top', fit: 'tile', pixelated: true }, eff, 'blob:x/1', 800);
  ok('layerVars: dim, blur, tile → repeat + auto, pixelated render, fade, url()',
    v['--myskin-dim'] === '60%' && v['--myskin-blur'] === '4px' && v['--myskin-fit'] === 'auto' && v['--myskin-repeat'] === 'repeat'
    && v['--myskin-render'] === 'pixelated' && v['--myskin-fade'] === '800ms' && v['--myskin-wallpaper'] === 'url("blob:x/1")');
  ok('layerVars: keywords and focal points become background-position',
    v['--myskin-pos'] === 'center top' && L.layerVars({ position: '30% 70%' }, eff, null, 0)['--myskin-pos'] === '30% 70%'
    && L.layerVars({ position: 'left' }, eff, null, 0)['--myskin-pos'] === 'left center'
    && L.layerVars({}, eff, null, 0)['--myskin-wallpaper'] === 'none');
  ok('layerVars: a hostile position can never reach CSS', L.layerVars({ position: 'center; background:url(//evil)' }, eff, null, 0)['--myskin-pos'] === 'center');
  ok('htmlClasses: per-theme layers add my-skin-layers (+ hide-overlay when asked)',
    L.htmlClasses({ enabled: true }, { wallpaper: true }, false, { layers: true, hideOverlay: true }).join(' ') === 'my-skin my-skin-wallpaper my-skin-layers my-skin-hide-overlay'
    && L.htmlClasses({ enabled: true }, { wallpaper: true }, false).join(' ') === 'my-skin my-skin-wallpaper');
  ok('htmlClasses: hide-overlay never appears without a picture', !L.htmlClasses({ enabled: true, side: 'left' }, { mascot: true }, false, { layers: true, hideOverlay: true }).includes('my-skin-hide-overlay'));
  ok('the per-theme encode spec: webp 0.82 / 2560 / jpeg fallback / under 3 MB',
    L.THEME_IMAGE_SPEC.type === 'image/webp' && L.THEME_IMAGE_SPEC.quality === 0.82 && L.THEME_IMAGE_SPEC.maxEdge === 2560
    && L.THEME_IMAGE_SPEC.fallbackType === 'image/jpeg' && L.THEME_IMAGE_SPEC.maxBytes === 3 * 1024 * 1024);
  ok('SLOT_NAMES still only the three fixed slots', L.SLOT_NAMES.join() === 'wallpaper,texture,mascot');
}

console.log('\n6. rules');
{
  const R = read('storage.rules');
  const m = R.match(/match \/skins\/\{uid\}\/themes\/\{themeId\}\/\{imageId\} \{([\s\S]*?)\n    \}/);
  const b = m ? strip(m[1]) : '';
  ok('skins/{uid}/themes/{themeId}/{imageId} block exists', !!m);
  ok('read is the owner only (no admin, no team, no company)', /allow read:\s*if isOwner\(uid\);/.test(b) && !/isAdmin|companyId|role/.test(b));
  ok('write: owner, themeId and imageId shape (optional _t thumbnail), <3MB, webp/jpeg only, null-safe content type',
    /allow create, update: if isOwner\(uid\)/.test(b) && /themeId\.matches\('\^\(_custom\|\[a-z0-9-\]\{1,40\}\)\$'\)/.test(b)
    && /imageId\.matches\('\^\[a-z0-9\]\{8,16\}\(_t\)\?\$'\)/.test(b) && /size < 3 \* 1024 \* 1024/.test(b)
    && /contentType != null/.test(b) && /matches\('image\/\(webp\|jpeg\)'\)/.test(b) && !/png|svg|gif/.test(b));
  ok('delete is the owner only', /allow delete:\s*if isOwner\(uid\);/.test(b));
  ok('the per-theme block sits before the default deny', R.indexOf('match /skins/{uid}/themes/') < R.indexOf('// ── DEFAULT DENY'));
  ok('the old fixed-slot block is untouched', /slot in \['wallpaper', 'texture', 'mascot'\]/.test(R) && /size < 4 \* 1024 \* 1024/.test(R));

  const F = strip(read('firestore.rules'));
  ok('userSettings: mySkin.themes is bounded to 220, create/update only (a delete has no resource.data)',
    /d\.mySkin\.themes\.size\(\) <= 220/.test(F)
    && /match \/userSettings\/\{uid\} \{\s*allow read: if isOwner\(uid\) \|\| isAdmin\(\);\s*allow create, update: if \(isOwner\(uid\) \|\| isAdmin\(\)\) && mySkinThemesBounded\(request\.resource\.data\);\s*allow delete: if isOwner\(uid\) \|\| isAdmin\(\);/.test(F));
  ok('the constants agree: 220 in logic and rules', L.MAX_THEME_ENTRIES === 220);

  // Erasure and offboarding already cover the nested prefix: the whole skins/ prefix.
  const U = read('functions/integrations/user-owned.js');
  ok('erasure/export list the whole skins prefix (so skins/{uid}/themes/** goes with it)', /'skins',/.test(U));
  const M = read('functions/member-storage-move.js');
  ok('a removed member\'s skins are never moved to the company owner', /NOT_MOVED_PREFIXES = new Set\(\['skins'\]\)/.test(M));
}

console.log('\n7. my-skin.js per-theme contract');
{
  const J = strip(read('docs/pro/js/my-skin.js'));
  ok('still no token download URL anywhere', !/getDownloadURL/.test(J));
  ok('pictures are read with getBlob and shown through blob: URLs', /st\.getBlob\(st\.ref\(window\.storage, path\)\)/.test(J) && /URL\.createObjectURL\(blob\)/.test(J));
  ok('only trustedImagePath() results are fetched', /L\(\)\.trustedImagePath\(uid, img\)/.test(J) && /if \(!path\) return Promise\.reject/.test(J));
  ok('every upload goes through the canvas re-encode first (EXIF/GPS dropped)',
    /function reencode\(file, spec\) \{ return encode\(file, spec, false, false\)/.test(J) && /return encode\(file, spec, true, true\)\.then/.test(J) && /createElement\('canvas'\)/.test(J));
  ok('uploads only to themeStoragePath(uid, themeId, minted id)', /var path = L\(\)\.themeStoragePath\(uid, themeId, id\)/.test(J) && /L\(\)\.mintImageId\(\)/.test(J));
  ok('the encoded blob is what is uploaded (lossy webp/jpeg content type)', /uploadBytes\(st\.ref\(window\.storage, path\), r\.blob,\s*\{ contentType: r\.blob\.type/.test(J));
  ok('a single theme is written by dotted field path (never the whole map)',
    /patch\['mySkin\.themes\.' \+ themeId\]/.test(J) && /f\.updateDoc\(ref, patch\)/.test(J) && /f\.deleteField\(\)/.test(J));
  ok('global save() keeps merge and does not list themes (another device\'s entries survive)',
    /\{ mySkin: out \}, \{ merge: true \}/.test(J) && !/out = \{[^}]*themes:/.test(J));
  ok('listens for themechange and modechange', /addEventListener\('themechange', onTheme\)/.test(J) && /addEventListener\('modechange', onMode\)/.test(J));
  ok('a newer theme switch discards older results (switchSeq)', /var seq = \+\+switchSeq/.test(J) && (J.match(/seq !== switchSeq/g) || []).length >= 3);
  ok('the new picture is decoded before it is swapped in', /decodeUrl\(h\.url\)/.test(J) && /\.decode\(\)/.test(J) && /function swapIn/.test(J));
  ok('two layers, #nbdSkinA / #nbdSkinB, hidden from assistive tech', /'nbdSkinA', 'nbdSkinB'/.test(J) && /setAttribute\('aria-hidden', 'true'\)/.test(J));
  ok('the disk cache is IndexedDB nbd-myskin keyed by uid (not Cache Storage)',
    /DB_NAME = 'nbd-myskin'/.test(J) && /return uid \+ '\|' \+ parts\[3\]/.test(J) && !/caches\.(open|match)/.test(J));
  ok('memory LRU: 8 entries / 40 MB and revoked on eviction', /MEM_MAX_ENTRIES = 8/.test(J) && /MEM_MAX_BYTES = 40 \* 1024 \* 1024/.test(J) && /revokeObjectURL\(mem\.get\(victim\)\.url\)/.test(J));
  ok('disk budget 150 MB, oldest first', /DISK_BUDGET = 150 \* 1024 \* 1024/.test(J) && /rows\.sort\(function \(a, b\) \{ return a\.at - b\.at; \}\)/.test(J));
  ok('sign-out cleanup: memory, layers, IndexedDB and the nbd_myskin_ session keys',
    /function purgeLocal/.test(J) && /deleteDatabase\(DB_NAME\)/.test(J) && /'nbd_myskin_'/.test(J) && /purgeLocal: purgeLocal/.test(J));
  ok('a different uid on the page drops everything held for the last one', /window\._user\.uid !== uid\) purgeMemory\(\)/.test(J));
  ok('browser storage is still not used for settings', !/localStorage/.test(J));
  ok('no innerHTML / inline handler assignments', !/innerHTML\s*=|\.on(click|change|input)\s*=/.test(J.replace(/im\.onload|im\.onerror/g, '')));
  ok('the wallpaper copy reuses the Blob (no fetch of a blob: URL, which connect-src would refuse)', !/fetch\(/.test(J));
  ok('objects are deleted only when nothing else references them', /L\(\)\.referencedPaths\(cfg\)/.test(J) && /!refs\[i\.path\]/.test(J));
  ok('a removed global slot also deletes the doc field (a merge alone can\'t)', /'mySkin\.slots\.' \+ slot/.test(J));
}

console.log('\n8. CSS, panel, wiring');
{
  const C = strip(read('docs/pro/css/my-skin.css'));
  ok('layers: ::before is retired while my-skin-layers is on', /:root\.my-skin-layers::before\s*\{\s*content:\s*none/.test(C));
  ok('the layer veil uses the live theme --bg and the per-layer dim', /\.myskin-layer\s*\{[^}]*color-mix\(in srgb, var\(--bg\) var\(--myskin-dim\), transparent\)/.test(C));
  ok('the layer is fixed, below content, and takes no pointer events', /\.myskin-layer\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*-1[^}]*pointer-events:\s*none/.test(C));
  ok('blur grows the layer so soft edges stay off screen', /inset:\s*calc\(var\(--myskin-blur\) \* -2\)/.test(C));
  const defaults = (C.match(/:where\(:root\)\s*\{([^}]*)\}/) || [])[1] || '';
  ok('--myskin-blur/pos/fit/repeat/render/fade have :where(:root) defaults (token-resolution gate)',
    ['blur', 'pos', 'fit', 'repeat', 'render', 'fade'].every((n) => new RegExp('--myskin-' + n + '\\s*:').test(defaults)));
  ok('hide-overlay rule is gated on the html class', /:root\.my-skin-hide-overlay #te-overlay\s*\{\s*display:\s*none\s*!important/.test(C));

  const D = read('docs/pro/dashboard.html');
  const P = D.slice(D.indexOf('id="myskinPanel"'), D.indexOf('<!-- SIDEBAR CUSTOMIZER -->'));
  const ids = ['myskinPerTheme', 'myskinThemeCard', 'myskinThemeName', 'myskinThemeStatus', 'myskinThemeDim', 'myskinThemeDimGlobal',
    'myskinThemeBlur', 'myskinThemeFit', 'myskinThemePixel', 'myskinThemeOverlay', 'myskinThemeOverride'];
  ok('the per-theme card has every control', ids.every((id) => P.includes('id="' + id + '"')), ids.filter((id) => !P.includes('id="' + id + '"')).join());
  ok('nine focal-point buttons, each labelled', (P.match(/data-myskin-pos="[^"]+"/g) || []).length === 9 && (P.match(/data-myskin-pos="[^"]+" aria-pressed="false" aria-label="[^"]+"/g) || []).length === 9);
  ok('the per-theme picker accepts images only', /accept="image\/\*" multiple data-myskin-theme-file/.test(P));
  ok('the thumbnail is masked from session recordings', /class="myskin-thumb" data-clarity-mask="true"/.test(P));
  ok('the privacy note is in the panel', /They stay private to you, just like your wallpaper/.test(P));
  ok('the card sits between the wallpaper and the texture slot',
    P.indexOf('data-myskin-slot="wallpaper"') < P.indexOf('id="myskinPerTheme"') && P.indexOf('id="myskinPerTheme"') < P.indexOf('data-myskin-slot="texture"'));
  ok('cache-busters bumped on both pages',
    ['docs/pro/dashboard.html', 'docs/pro/customer.html'].every((p) => { const h = read(p);
      return /css\/my-skin\.css\?v=5/.test(h) && /js\/my-skin-logic\.js\?v=5/.test(h) && /js\/my-skin\.js\?v=7/.test(h); }));

  const A = read('docs/pro/js/nbd-auth.js');
  ok('sign-out / account-switch purge calls NBDMySkin.purgeLocal (with an IndexedDB fallback)',
    /window\.NBDMySkin\.purgeLocal\(\)/.test(A) && /deleteDatabase\('nbd-myskin'\)/.test(A));
  ok('login reset drops the database even where indexedDB.databases() is missing', /deleteDatabase\('nbd-myskin'\)/.test(read('docs/pro/js/login-reset.js')));
  const K = read('docs/pro/js/dashboard-custom-theme.js');
  ok('Custom Builder marks itself (data-custom-theme) so My Skin keys it as _custom, and clears it on reset',
    /setAttribute\('data-custom-theme', '1'\)/.test(K) && /removeAttribute\('data-custom-theme'\)/.test(K));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
