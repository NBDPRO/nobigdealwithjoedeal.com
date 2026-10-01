/**
 * tests/my-skin-2026-10-01.test.js — "My Skin" (Jo, 2026-10-01: a Mario
 * underground / Pokémon look with the real art, which can't ship in the
 * product, so each user uploads their own pictures for their own screen).
 *
 *   1. my-skin-logic.js behaviour: config normalisation, slot paths, the
 *      trusted-path guard, upload checks, resize maths, accent contrast,
 *      css vars and html classes
 *   2. storage.rules: skins/{uid}/{slot} is owner-only (no admin/team read),
 *      fixed slot names, raster-only, 4MB (the emulator cases live in
 *      storage-rules.test.js)
 *   3. my-skin.js privacy contract: getBlob under the rules, never a token
 *      download URL; canvas re-encode before upload; only trusted paths fetched;
 *      settings on userSettings, not localStorage
 *   4. my-skin.css is fully gated on the html classes; panel markup present on
 *      the dashboard; both pages load the files
 *
 * Run: node tests/my-skin-2026-10-01.test.js
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

console.log('\n1. my-skin-logic');
{
  const d = L.normalize(undefined);
  ok('missing config → off, default dim/texture, left mascot, no slots',
    d.enabled === false && d.dim === L.DIM_DEFAULT && d.texture === 0.18 && d.side === 'left' && Object.keys(d.slots).length === 0 && d.accent === null);
  const n = L.normalize({ enabled: 'yes', dim: 7, texture: -1, accent: 'red', side: 'top', slots: { wallpaper: { path: 'skins/u1/wallpaper', v: '5' }, evil: { path: 'x' }, mascot: {} } });
  ok('only a literal true enables', n.enabled === false);
  ok('dim and texture are clamped', n.dim === L.DIM_MAX && n.texture === 0);
  ok('a non-hex accent is dropped; a bad side falls back', n.accent === null && n.side === 'left');
  ok('unknown slots and empty slots are dropped', Object.keys(n.slots).join() === 'wallpaper' && n.slots.wallpaper.v === 5);
  ok('accent hex is lower-cased', L.normalize({ accent: '#ABCDEF' }).accent === '#abcdef');

  ok('storagePath builds skins/{uid}/{slot}', L.storagePath('u1', 'mascot') === 'skins/u1/mascot');
  ok('storagePath refuses unknown slots and path-y uids',
    L.storagePath('u1', 'avatar') === null && L.storagePath('a/b', 'wallpaper') === null && L.storagePath('', 'wallpaper') === null);
  const cfg = L.normalize({ slots: { wallpaper: { path: 'skins/u1/wallpaper' }, texture: { path: 'skins/OTHER/texture' }, mascot: { path: 'photos/u1/x.jpg' } } });
  ok('trustedPath accepts only the caller’s own skins/{uid}/{slot}',
    L.trustedPath(cfg, 'u1', 'wallpaper') === 'skins/u1/wallpaper' && L.trustedPath(cfg, 'u1', 'texture') === null && L.trustedPath(cfg, 'u1', 'mascot') === null);
  ok('trustedPath is null for another signed-in user', L.trustedPath(cfg, 'u2', 'wallpaper') === null);

  ok('checkInput accepts a phone photo', L.checkInput({ type: 'image/heic', size: 3e6 }).ok);
  ok('checkInput refuses SVG (script-capable)', !L.checkInput({ type: 'image/svg+xml', size: 1000 }).ok);
  ok('checkInput refuses non-images, empty and >20MB files',
    !L.checkInput({ type: 'application/pdf', size: 1000 }).ok && !L.checkInput({ type: 'image/png', size: 0 }).ok && !L.checkInput({ type: 'image/png', size: 21e6 }).ok && !L.checkInput(null).ok);

  const f = L.fitWithin(4032, 3024, 2560);
  ok('fitWithin scales the long edge down, keeping aspect', f.w === 2560 && f.h === 1920);
  ok('fitWithin never scales up', JSON.stringify(L.fitWithin(300, 200, 512)) === JSON.stringify({ w: 300, h: 200 }));
  ok('fitWithin handles portrait', L.fitWithin(1000, 4000, 512).h === 512);

  ok('slots: wallpaper is JPEG (no alpha), texture and mascot keep transparency',
    L.SLOTS.wallpaper.type === 'image/jpeg' && L.SLOTS.texture.type === 'image/png' && L.SLOTS.mascot.type === 'image/png');

  ok('contrast(white, black) ≈ 21', Math.abs(L.contrast('#ffffff', '#000000') - 21) < 0.1);
  const good = L.accentCheck('#38e1ff', '#070b24');
  ok('a bright accent on a dark page passes with a dark label', good.ok && good.fg === '#0b0f14' && good.label >= 4.5);
  const muddy = L.accentCheck('#1a2a4a', '#12223d');
  ok('an accent that blends into the page is refused', !muddy.ok && /blends/.test(muddy.reason));
  ok('a non-colour is refused', !L.accentCheck('blue', '#000000').ok);

  const v = L.cssVars({ dim: 0.5, texture: 0.2, accent: '#38e1ff' }, { wallpaper: 'blob:x/1' }, '#0b0f14');
  ok('cssVars: percentages, url(), none for a missing slot', v['--myskin-dim'] === '50%' && v['--myskin-texture-strength'] === '20%'
    && v['--myskin-wallpaper'] === 'url("blob:x/1")' && v['--myskin-texture'] === 'none');
  ok('cssVars: the accent travels as --myskin-accent (never --orange directly)', v['--myskin-accent'] === '#38e1ff' && v['--myskin-accent-fg'] === '#0b0f14' && !('--orange' in v));
  ok('cssVars: no accent vars without a checked label colour', !('--myskin-accent' in L.cssVars({ accent: '#38e1ff' }, {}, null)));

  ok('htmlClasses: off → nothing, even with pictures', L.htmlClasses({ enabled: false }, { wallpaper: true }, false).length === 0);
  ok('htmlClasses: on with nothing to show → nothing', L.htmlClasses({ enabled: true }, {}, false).length === 0);
  ok('htmlClasses: on with a wallpaper and mascot', L.htmlClasses({ enabled: true, side: 'right' }, { wallpaper: true, mascot: true }, false).join(' ')
    === 'my-skin my-skin-wallpaper my-skin-mascot my-skin-mascot-right');
  ok('htmlClasses: an accent only counts once it passed the check',
    L.htmlClasses({ enabled: true, accent: '#38e1ff' }, {}, false).length === 0
    && L.htmlClasses({ enabled: true, accent: '#38e1ff' }, {}, true).join(' ') === 'my-skin my-skin-accent');
}

console.log('\n2. storage.rules');
{
  const R = read('storage.rules');
  const m = R.match(/match \/skins\/\{uid\}\/\{slot\} \{([\s\S]*?)\n    \}/);
  const b = m ? strip(m[1]) : '';
  ok('skins/{uid}/{slot} block exists', !!m);
  ok('read is the owner only (no admin, no team)', /allow read:\s*if isOwner\(uid\);/.test(b) && !/isAdmin|companyId|role/.test(b));
  ok('writes: fixed slot names, <4MB, raster jpeg/png/webp, null-safe content type',
    /slot in \['wallpaper', 'texture', 'mascot'\]/.test(b) && /size < 4 \* 1024 \* 1024/.test(b)
    && /contentType != null/.test(b) && /matches\('image\/\(jpeg\|png\|webp\)'\)/.test(b));
  ok('delete is the owner only', /allow delete:\s*if isOwner\(uid\);/.test(b));
  ok('the block sits before the default deny', R.indexOf('match /skins/{uid}/{slot}') < R.indexOf('// ── DEFAULT DENY'));
}

console.log('\n3. my-skin.js privacy contract');
{
  const J = strip(read('docs/pro/js/my-skin.js'));
  ok('reads images with getBlob (rules-enforced)', /st\.getBlob\(/.test(J));
  ok('never mints a token download URL', !/getDownloadURL/.test(J));
  ok('fetches only trustedPath() results', /L\(\)\.trustedPath\(cfg, uid, slot\)/.test(J) && !/getBlob\([^)]*cfg\.slots/.test(J));
  ok('re-encodes through a canvas before upload (drops EXIF, caps size)', /createElement\('canvas'\)/.test(J) && /toBlob\(/.test(J) && /uploadBytes\(st\.ref\(window\.storage, path\), blob/.test(J));
  ok('uploads only to storagePath(uid, slot)', /var path = L\(\)\.storagePath\(uid, slot\)/.test(J));
  ok('settings live on userSettings/{uid}.mySkin, not localStorage', /'userSettings', uid\), \{ mySkin:/.test(J) && !/localStorage/.test(J));
  ok('no inline handlers or innerHTML', !/innerHTML\s*=|\.on(click|change|input)\s*=/.test(J.replace(/im\.onload|im\.onerror/g, '')));
  ok('the mascot is decorative (alt="", aria-hidden)', /mascot\.alt = ''/.test(J) && /aria-hidden', 'true'/.test(J));
  ok('object URLs are revoked when replaced', /URL\.revokeObjectURL\(urls\[slot\]\)/.test(J));
}

console.log('\n4. CSS gating, panel, page wiring');
{
  const C = strip(read('docs/pro/css/my-skin.css'));
  const sels = [];
  C.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '').replace(/([^{}]+)\{/g, (_, s) => {
    s = s.trim(); if (!s || s.startsWith('@') || /^(from|to|\d+%)$/.test(s)) return;
    // split on top-level commas only (":is(.a, .b)" is one selector)
    let depth = 0, cur = '';
    for (const ch of s) {
      if (ch === '(') depth++; else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { sels.push(cur.trim()); cur = ''; } else cur += ch;
    }
    sels.push(cur.trim());
  });
  // ':where(:root)' holds only zero-specificity --myskin-* defaults (checked below).
  const gated = (s) => s === ':where(:root)' || /^:root(:not\(\[data-motion="reduce"\]\))?\.my-skin|^:root\.my-skin|^\.myskin-|^:root:not\(\[data-motion="reduce"\]\) \.myskin-/.test(s);
  ok('positive control: selectors parsed', sels.length > 20, sels.length + ' selectors');
  ok('every rule is gated on a my-skin html class or a .myskin- element', sels.every(gated), JSON.stringify(sels.filter((s) => !gated(s))));
  const defaults = (C.match(/:where\(:root\)\s*\{([^}]*)\}/) || [])[1] || '';
  ok('the :where(:root) block only defines --myskin-* variables',
    !!defaults && defaults.split(';').map((d) => d.trim()).filter(Boolean).every((d) => /^--myskin-[a-z-]+\s*:/.test(d)));
  ok('the accent override is !important (survives theme repaints)', /:root\.my-skin-accent\s*\{[^}]*--orange:\s*var\(--myskin-accent\)\s*!important/.test(C));
  ok('the mascot ignores pointer events and sits under the nav (z 1800 < 1900)', /\.myskin-mascot\s*\{[^}]*pointer-events:\s*none[^}]*z-index:\s*1800/.test(C));
  ok('the mascot only animates when motion is allowed', /@media \(prefers-reduced-motion: no-preference\)\s*\{\s*:root:not\(\[data-motion="reduce"\]\) \.myskin-mascot/.test(C));
  ok('controls are 44px tap targets', /\.myskin-btn\s*\{[^}]*min-height:\s*44px/.test(C) && /\.myskin-row\s*\{[^}]*min-height:\s*44px/.test(C));

  const D = read('docs/pro/dashboard.html');
  ok('dashboard has the My Skin panel with all three slots',
    /id="myskinPanel"/.test(D) && ['wallpaper', 'texture', 'mascot'].every((s) => D.includes('data-myskin-file="' + s + '"') && D.includes('data-myskin-remove="' + s + '"')));
  ok('panel controls: enable, dim, texture, side, accent, reset',
    ['myskinEnabled', 'myskinDim', 'myskinTexture', 'myskinSide', 'myskinAccent', 'myskinAccentReset'].every((id) => D.includes('id="' + id + '"')));
  ok('file pickers accept images only', (D.match(/data-myskin-file="[a-z]+"/g) || []).length === 3 && !/accept="(?!image\/\*)[^"]*"[^>]*data-myskin-file/.test(D));
  const P = D.slice(D.indexOf('id="myskinPanel"'), D.indexOf('<!-- SIDEBAR CUSTOMIZER -->'));
  ok('the panel adds no inline style or handler', !/\sstyle=|\son[a-z]+=/.test(P));
  for (const page of ['docs/pro/dashboard.html', 'docs/pro/customer.html']) {
    const h = read(page);
    ok(`${page.split('/').pop()} loads my-skin.css and both scripts (logic first, deferred)`,
      /css\/my-skin\.css\?v=\d+/.test(h) && /<script defer src="js\/my-skin-logic\.js\?v=\d+"><\/script>\s*<script defer src="js\/my-skin\.js\?v=\d+"><\/script>/.test(h));
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
