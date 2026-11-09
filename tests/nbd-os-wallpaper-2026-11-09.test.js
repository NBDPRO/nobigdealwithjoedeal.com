/**
 * tests/nbd-os-wallpaper-2026-11-09.test.js - NBD OS P1, wallpapers: the
 * per-surface id in layoutState['os-home'], the time-of-day period, the CSS
 * that paints it, and the contrast of widget text over every gradient
 * (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §3.5, §3.6, §8 P1).
 *
 *   1. wp:{ phone, desk } in home-logic normalize: 'tod', 'none' or a My Skin
 *      image id, never a URL or a path; absent = default (and left out, so a
 *      P0 home normalises byte-for-byte as before); setWp keeps the other surface
 *   2. the max-fill key with wp still fits the 12,000-char budget
 *   3. todPeriod's four periods and their edges; Sunlight forces day
 *   4. css/layouts/os.css: four gradients from theme tokens only (no hex, no new
 *      hue, no image bytes), no backdrop-filter on a card, the My Skin picture
 *      as one pre-dimmed layer, a company-enforced My Skin background and
 *      Sunlight win, no motion
 *   5. contrast: widget text (--t, --m) on the widget glass (--s at 88%) over
 *      every gradient stop, and --t (icon labels) on the bare gradient, >= 4.5:1
 *      in the default dark theme and the light ones, computed from the real
 *      theme-engine.js token values; and no theme whose text read at 4.5:1 on
 *      its plain background drops under 4.5:1 on any period
 *
 * Run: node tests/nbd-os-wallpaper-2026-11-09.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 600) : '')); }
}
const J = (v) => JSON.stringify(v);
const G = (fn) => { try { fn(); } catch (e) { ok('section ran without throwing', false, e && e.stack); } };
const H = require(path.join(ROOT, 'docs/pro/js/os/home-logic.js'));
const R = require(path.join(ROOT, 'docs/pro/js/layout-system.js'));
const has = (name) => typeof H[name] === 'function';

console.log('\n1. wp in the os-home key');
G(() => {
  ok('home-logic exports cleanWp / wpOf / setWp / todPeriod / wpPaint', ['cleanWp', 'wpOf', 'setWp', 'todPeriod', 'wpPaint'].every(has));
  if (!has('cleanWp')) return;
  ok('built-ins: tod and none', H.cleanWp('tod') === 'tod' && H.cleanWp('none') === 'none');
  ok('a My Skin image id (8-16 of a-z0-9) is kept', H.cleanWp('lq3x9a1b2c') === 'lq3x9a1b2c' && H.cleanWp('a'.repeat(16)) === 'a'.repeat(16));
  const junk = ['https://x.test/a.jpg', 'blob:https://x/1', 'skins/u1/themes/p/lq3x9a1b2c', 'url(x)', 'LQ3X9A1B2C', 'short', 'a'.repeat(17), '', null, 7, {}, ['tod'], 'tod ', '<img>'];
  ok('URLs, paths, upper case, wrong lengths and non-strings are dropped', junk.every((v) => H.cleanWp(v) === null), J(junk.map(H.cleanWp)));
  const d = H.defaults();
  ok('nothing chosen: no wp in the key (a P0 home normalises unchanged)', !('wp' in H.normalize({ phone: d.phone, desk: d.desk })) && !('wp' in H.normalize({ phone: d.phone, desk: d.desk, wp: { phone: 'x', desk: null } })));
  const k = H.normalize({ phone: d.phone, desk: d.desk, wp: { phone: 'tod', desk: 'lq3x9a1b2c', extra: 'none', url: 'https://x' } });
  ok('wp keeps phone and desk only, each cleaned', J(k.wp) === J({ phone: 'tod', desk: 'lq3x9a1b2c' }), J(k.wp));
  ok('one surface set, the other null', J(H.normalize({ wp: { desk: 'none' } }).wp) === J({ phone: null, desk: 'none' }));
  ok('wpOf reads a surface; null when unset or unknown', H.wpOf(k, 'phone') === 'tod' && H.wpOf(k, 'desk') === 'lq3x9a1b2c' && H.wpOf({}, 'phone') === null && H.wpOf(k, 'tv') === null);
  const s1 = H.setWp(k, 'phone', 'none');
  ok('setWp changes one surface and keeps the other (and the widgets)', J(s1.wp) === J({ phone: 'none', desk: 'lq3x9a1b2c' }) && J(s1.phone) === J(d.phone) && J(k.wp) === J({ phone: 'tod', desk: 'lq3x9a1b2c' }));
  ok('setWp to null on both: wp leaves the key', !('wp' in H.setWp(H.setWp(k, 'phone', null), 'desk', null)));
  ok('setWp ignores a URL (stays default) and an unknown surface', H.wpOf(H.setWp(k, 'phone', 'https://evil'), 'phone') === null && J(H.setWp(k, 'tv', 'tod')) === J(k));
  const rt = H.normalize(JSON.parse(J(k)));
  ok('round trip: normalise -> JSON -> normalise unchanged', J(rt) === J(k));
  ok('it survives LayoutRegistry.normalizeUser', J(H.normalize(R.normalizeUser({ layoutState: { 'os-home': k } }).layoutState['os-home'])) === J(k));
});

console.log('\n2. max-fill with wp fits the 12,000-char budget');
G(() => {
  if (!has('cleanWp')) { ok('wp exists to fill', false); return; }
  const cfgIds = H.ids().filter((id) => H.CATALOG[id].config);
  let worst = { id: 'shortcuts', s: 'm' };
  cfgIds.forEach((id) => {
    const conf = H.CATALOG[id].config; const cfg = {};
    Object.keys(conf).forEach((c) => { cfg[c] = conf[c].reduce((a, b) => (String(b).length > String(a).length ? b : a)); });
    const it = { id, s: 'm', cfg: H.cleanCfg(id, cfg) || undefined };
    if (J(it).length > J(worst).length) worst = it;
  });
  const fill = []; for (let i = 0; i < 30; i++) fill.push(worst);
  const st = H.normalize({ v: 1, phone: fill, desk: fill, wp: { phone: 'z'.repeat(16), desk: 'y'.repeat(16) } });
  const len = J(st).length;
  ok('the max-fill key carries both 16-char ids', st.wp && st.wp.phone.length === 16 && st.wp.desk.length === 16);
  ok('…and serialises under 12,000 chars (' + len + ')', len < 12000 && len <= R.MAX_STATE_JSON, len);
  ok('LayoutRegistry keeps it', !!R.normalizeUser({ layoutState: { 'os-home': st } }).layoutState['os-home']);
});

console.log('\n3. the time-of-day period');
G(() => {
  if (!has('todPeriod')) { ok('todPeriod exists', false); return; }
  const at = (h, m) => new Date(2026, 10, 9, h, m || 0).getTime();
  const cases = [[4, 59, 'night'], [5, 0, 'dawn'], [7, 59, 'dawn'], [8, 0, 'day'], [13, 5, 'day'], [16, 59, 'day'], [17, 0, 'dusk'], [19, 59, 'dusk'], [20, 0, 'night'], [0, 0, 'night'], [23, 59, 'night']];
  const got = cases.map(([h, m]) => H.todPeriod(at(h, m)));
  ok('dawn 5-8, day 8-17, dusk 17-20, night 20-5 (local)', J(got) === J(cases.map((c) => c[2])), J(got));
  ok('a bad clock reads as day, never throws', H.todPeriod(NaN) === 'day' && H.todPeriod(undefined) === 'day');
  ok('wpPaint: nothing chosen -> auto with the period', J(H.wpPaint(null, { now: at(21) })) === J({ wp: 'auto', tod: 'night', img: null }));
  ok('wpPaint: tod / none as chosen', H.wpPaint('tod', { now: at(6) }).wp === 'tod' && H.wpPaint('tod', { now: at(6) }).tod === 'dawn' && H.wpPaint('none', { now: at(6) }).wp === 'none');
  ok('wpPaint: an image id -> img with the id', J(H.wpPaint('lq3x9a1b2c', { now: at(12) })) === J({ wp: 'img', tod: 'day', img: 'lq3x9a1b2c' }));
  ok('wpPaint: Sunlight forces day at night', H.wpPaint(null, { now: at(22), sun: true }).tod === 'day' && H.wpPaint('tod', { now: at(18), sun: true }).tod === 'day');
  ok('wpPaint: junk stored -> auto', H.wpPaint('https://x', { now: at(12) }).wp === 'auto');
});

// ── CSS ──────────────────────────────────────────────────────
const OS_CSS = read('docs/pro/css/layouts/os.css');
const HOME_CSS = read('docs/pro/css/os/home.css');
const WP0 = OS_CSS.indexOf('/* ── wallpaper (P1');
const WP_CSS = WP0 === -1 ? '' : OS_CSS.slice(WP0);
const PERIODS = ['dawn', 'day', 'dusk', 'night'];
const STOP_RE = /--os-wp-([abc]):\s*color-mix\(in srgb, var\(--([\w-]+)\) (\d+)%, var\(--([\w-]+)\)\);/g;
function periods() {
  const out = {};
  const re = /\[data-os-tod="(\w+)"\]\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(WP_CSS))) {
    out[m[1]] = {};
    let k; STOP_RE.lastIndex = 0;
    while ((k = STOP_RE.exec(m[2]))) out[m[1]][k[1]] = [k[2], Number(k[3]), k[4]];
  }
  return out;
}
const P = periods();
const TOKENS = ['bg', 's', 's2', 's3', 't', 'm', 'orange', 'blue', 'gold', 'red', 'green'];

console.log('\n4. the wallpaper CSS');
G(() => {
  ok('os.css has a wallpaper section', WP0 !== -1);
  ok('four periods, each three stops a/b/c', PERIODS.every((p) => P[p] && ['a', 'b', 'c'].every((s) => Array.isArray(P[p][s]))), J(P));
  ok('every stop mixes two theme tokens, mostly --bg (>= 80%): already pre-dimmed', PERIODS.every((p) => P[p] && ['a', 'b', 'c'].every((s) => {
    const st = P[p][s]; return st && st[0] === 'bg' && st[1] >= 80 && st[1] < 100 && TOKENS.indexOf(st[2]) !== -1;
  })));
  ok('no hex, rgb() or hsl() literal in the wallpaper section (tokens only, DESIGN.md "Color")', !/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(WP_CSS.replace(/\/\*[\s\S]*?\*\//g, '')));
  ok('no image bytes: the only url is the --os-wp-img custom property os/wallpaper.js sets', !/url\(/.test(WP_CSS.replace(/\/\*[\s\S]*?\*\//g, '')));
  ok('the gradient paints .os-desk and .os-phone for auto and tod', /\.os-desk\[data-os-wp="auto"\][\s\S]*?\.os-phone\[data-os-wp="tod"\][^{]*\{\s*background: linear-gradient\(180deg, var\(--os-wp-a\)/.test(WP_CSS));
  ok('a My Skin picture is ONE pre-dimmed layer: a --bg veil over var(--os-wp-img) in a single ::before',
    /\[data-os-wp="img"\]::before[^{]*\{[^}]*background: linear-gradient\(var\(--os-wp-veil\), var\(--os-wp-veil\)\), var\(--os-wp-img, none\)/.test(WP_CSS)
    && /--os-wp-veil: color-mix\(in srgb, var\(--bg\) var\(--os-wp-dim, 55%\), transparent\)/.test(WP_CSS));
  ok('on a picture, icon labels get a token chip (--bg at 72%)', /\[data-os-wp="img"\] \.os-icon-label, \[data-os-wp="img"\] \.os-p-label \{[^}]*background: color-mix\(in srgb, var\(--bg\) 72%, transparent\)/.test(WP_CSS));
  ok('the default gives way to a My Skin picture (html.my-skin-wallpaper)', /html\.my-skin-wallpaper \.os-desk\[data-os-wp="auto"\][^{]*\{\s*background: none/.test(WP_CSS));
  ok('a company-enforced My Skin background wins over every choice (html.my-skin-locked)', /html\.my-skin-locked \.os-desk\[data-os-wp\][^{]*\{\s*background: none/.test(WP_CSS) && /html\.my-skin-locked \[data-os-wp\]::before \{ content: none; \}/.test(WP_CSS));
  ok('Sunlight: a plain background, no picture (html.sun-all)', /html\.sun-all \.os-desk\[data-os-wp\][^{]*\{\s*background: var\(--bg\)/.test(WP_CSS) && /html\.sun-all \[data-os-wp\]::before \{ content: none; \}/.test(WP_CSS));
  ok('no motion: no transition or animation in the wallpaper section', !/transition|animation/.test(WP_CSS.replace(/\/\*[\s\S]*?\*\//g, '')));
  const nc = (c) => c.replace(/\/\*[\s\S]*?\*\//g, '');
  ok('no backdrop-filter on a widget card (os.css and home.css; only the dialog\'s ::backdrop colour)', !/backdrop-filter/.test(nc(OS_CSS)) && !/backdrop-filter/.test(nc(HOME_CSS)));
  ok('the widget glass stays token glass: --s at 88% with --ui-elev-1', /\.os-hw \{[^}]*background: color-mix\(in srgb, var\(--s\) 88%, transparent\);[^}]*box-shadow: var\(--ui-elev-1\)/.test(HOME_CSS));
  const pick = HOME_CSS.slice(HOME_CSS.indexOf('/* ── Wallpaper picker'));
  ok('home.css styles the picker; its targets are 44px and up, its text 11px and up',
    pick.length > 100 && /\.os-wp-opt \{[^}]*min-height: 56px/.test(pick) && /\.os-wp-more, \.os-wp-done \{ min-height: 44px; \}/.test(pick)
    && !/font-size: (?:[0-9]|10)px/.test(pick));
  ok('the picker CSS has no hex literal and no motion', !/#[0-9a-f]{3,8}\b/i.test(pick) && !/transition|animation/.test(pick));
});

// ── contrast, from theme-engine.js's own palettes and helpers ─────
console.log('\n5. contrast over every gradient');
G(() => {
  const src = read('docs/pro/js/theme-engine.js');
  const t0 = src.indexOf('  const THEMES = {'); const t1 = src.indexOf('\n  };\n', t0) + 5;
  const h0 = src.indexOf('function parseHex'); const h1 = src.indexOf('function pickContrastingPair', h0);
  ok('extracted THEMES and the colour helpers from theme-engine.js', t0 > 0 && t1 > t0 && h0 > 0 && h1 > h0);
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(src.slice(t0, t1).replace('const THEMES', 'var THEMES') + '\n' + src.slice(h0, h1) + '\nthis.X = { THEMES, adjustHex, tuneAgainst, contrastRatio, parseHex };', ctx);
  const { THEMES, adjustHex, tuneAgainst, contrastRatio, parseHex } = ctx.X;
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  // color-mix(in srgb, A p%, B): p of A, the rest B; with transparent, A at alpha p over what is under it
  const mix = (a, p, b) => { const A = parseHex(a), B = parseHex(b), f = p / 100; return hex({ r: A.r * f + B.r * (1 - f), g: A.g * f + B.g * (1 - f), b: A.b * f + B.b * (1 - f) }); };
  // theme-engine.js generateCSSVariables, in the theme's own mode: --bg derived, --s = bg, --s3 = surface2,
  // --m tuned to 4.5 against the surface, --orange tuned to 3 against --bg
  function tokens(th) {
    const c = th.colors, light = th.mode === 'light';
    const bg = c.outerBg || (light ? adjustHex(c.bg, 0.02) : adjustHex(c.bg, -0.18));
    return { bg, s: c.bg, s2: c.surface, s3: c.surface2, t: c.text, m: tuneAgainst(c.muted, c.surface || c.surface2 || c.bg, 4.5),
      orange: tuneAgainst(c.accent, bg, 3), blue: c.blue, gold: c.gold, red: c.red, green: c.green };
  }
  function check(T) {
    const out = [];
    PERIODS.forEach((p) => ['a', 'b', 'c'].forEach((s, i, arr) => {
      const st = P[p] && P[p][s]; if (!st) return;
      const stop = mix(T[st[0]], st[1], T[st[2]]);
      const list = [stop];
      if (i < arr.length - 1 && P[p][arr[i + 1]]) { const n = P[p][arr[i + 1]]; list.push(mix(stop, 50, mix(T[n[0]], n[1], T[n[2]]))); }   // the midpoint to the next stop
      list.forEach((px) => {
        const glass = mix(T.s, 88, px);
        out.push({ p, s, t: contrastRatio(T.t, glass), m: contrastRatio(T.m, glass), bare: contrastRatio(T.t, px) });
      });
    }));
    return out;
  }
  const usable = Object.keys(THEMES).filter((id) => { const c = THEMES[id].colors; if (!c) return false; const T = tokens(THEMES[id]); return TOKENS.every((k) => parseHex(T[k])); });
  const light = usable.filter((id) => THEMES[id].mode === 'light');
  ok('the sweep covers the palette: ' + usable.length + ' themes, ' + light.length + ' of them light', usable.length >= 150 && light.length >= 5 && usable.indexOf('nbd-original') !== -1 && usable.indexOf('paper') !== -1);
  // the default dark theme, another dark one, and the light themes whose text reads at 4.5:1 on the plain glass today
  const baseOk = (id) => { const T = tokens(THEMES[id]); const g0 = mix(T.s, 88, T.bg); return contrastRatio(T.t, g0) >= 4.5 && contrastRatio(T.m, g0) >= 4.5 && contrastRatio(T.t, T.bg) >= 4.5; };
  const MUST = ['nbd-original', 'midnight'].concat(light.filter(baseOk));
  ok('the light themes checked strictly include paper (' + MUST.length + ' themes in all)', MUST.indexOf('paper') !== -1 && MUST.length >= 7, MUST.join(','));
  MUST.forEach((id) => {
    const r = check(tokens(THEMES[id]));
    const worst = r.reduce((a, b) => ({ t: Math.min(a.t, b.t), m: Math.min(a.m, b.m), bare: Math.min(a.bare, b.bare) }), { t: 99, m: 99, bare: 99 });
    ok(id + ' (' + (THEMES[id].mode || 'dark') + '): --t ' + worst.t.toFixed(2) + ', --m ' + worst.m.toFixed(2) + ' on the glass, --t ' + worst.bare.toFixed(2) + ' bare: all >= 4.5',
      r.length === 20 && worst.t >= 4.5 && worst.m >= 4.5 && worst.bare >= 4.5, J(r.filter((x) => x.t < 4.5 || x.m < 4.5 || x.bare < 4.5)));
  });
  // every theme: where text already read at 4.5:1 on the plain page, no period takes it under
  const drops = [];
  usable.forEach((id) => {
    const T = tokens(THEMES[id]);
    const g0 = mix(T.s, 88, T.bg);
    const base = { t: contrastRatio(T.t, g0), m: contrastRatio(T.m, g0), bare: contrastRatio(T.t, T.bg) };
    check(T).forEach((x) => ['t', 'm', 'bare'].forEach((k) => { if (base[k] >= 4.5 && x[k] < 4.5) drops.push(id + ' ' + x.p + x.s + ' ' + k + ' ' + x[k].toFixed(2)); }));
  });
  ok('no theme drops under 4.5:1 on any period where it read at 4.5:1 without a wallpaper (' + usable.length + ' themes x 4 periods)', drops.length === 0, drops.slice(0, 12).join('; '));
});

console.log('\n5b. a My Skin picture: the label chip over the veil, the worst pictures');
G(() => {
  const src = read('docs/pro/js/theme-engine.js');
  const t0 = src.indexOf('  const THEMES = {'); const t1 = src.indexOf('\n  };\n', t0) + 5;
  const h0 = src.indexOf('function parseHex'); const h1 = src.indexOf('function pickContrastingPair', h0);
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(src.slice(t0, t1).replace('const THEMES', 'var THEMES') + '\n' + src.slice(h0, h1) + '\nthis.X = { THEMES, adjustHex, contrastRatio, parseHex };', ctx);
  const { THEMES, adjustHex, contrastRatio, parseHex } = ctx.X;
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const mix = (a, p, b) => { const A = parseHex(a), B = parseHex(b), f = p / 100; return hex({ r: A.r * f + B.r * (1 - f), g: A.g * f + B.g * (1 - f), b: A.b * f + B.b * (1 - f) }); };
  const worst = ['nbd-original', 'midnight', 'paper'].map((id) => {
    const th = THEMES[id], c = th.colors, light = th.mode === 'light';
    const bg = c.outerBg || (light ? adjustHex(c.bg, 0.02) : adjustHex(c.bg, -0.18));
    // the veil at 0% (no dim at all) is the worst case; the guard only raises it
    return Math.min.apply(null, ['#000000', '#ffffff', '#808080', '#ff0000', '#ffff00'].map((pic) => contrastRatio(c.text, mix(bg, 72, mix(bg, 0, pic)))));
  });
  ok('--t on the chip over a black, white, grey, red or yellow picture with no veil at all: >= 4.5:1 (' + worst.map((n) => n.toFixed(2)).join(', ') + ')', worst.every((n) => n >= 4.5));
});

console.log('\n6. the company lock comes from My Skin\'s own precedence');
G(() => {
  const ML = require(path.join(ROOT, 'docs/pro/js/my-skin-logic.js'));
  const cimg = { id: 'lq3x9a1b2c', path: 'companies/co1/skins/themes/paper/lq3x9a1b2c', v: 1, w: 9, h: 9, type: 'image/webp' };
  const co = ML.normalizeCompany({ enabled: true, themes: { paper: { images: [cimg], mode: 'enforced' } } });
  ok('resolveWithCompany: an enforced set is locked; a suggested one is not',
    ML.resolveWithCompany({}, co, 'paper').locked === true && ML.resolveWithCompany({}, ML.normalizeCompany({ enabled: true, themes: { paper: { images: [cimg], mode: 'suggested' } } }), 'paper').locked === false);
  const MS = read('docs/pro/js/my-skin.js');
  ok('my-skin.js paint() marks <html> my-skin-locked from that very result (layerPic.style.locked)', /if \(layerPic && layerPic\.style && layerPic\.style\.locked\) root\.classList\.add\('my-skin-locked'\);/.test(MS));
  ok('…and its /^my-skin/ sweep takes the class off on the next paint', /var CLASS_RE = \/\^my-skin\/;/.test(MS));
  ok('my-skin.js lends the OS ids and Blobs, never a URL: images(), imageBlob(), locked(); no getDownloadURL', /images: ownImages,/.test(MS) && /imageBlob: ownImageBlob,/.test(MS) && /locked: function/.test(MS) && !/getDownloadURL/.test(MS));
  ok('imageBlob reads only this member\'s own pictures (trustedImagePath / trustedThumbPath)', /function ownImage\(id\)[\s\S]*?trustedImagePath\(uid, im\)/.test(MS) && /function ownImageBlob[\s\S]*?trustedThumbPath\(uid, im\)/.test(MS));
  ok('the my-skin.js cache-buster is bumped with it (v=13)', /js\/my-skin\.js\?v=13\b/.test(read('docs/pro/js/my-skin-boot.js')));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
