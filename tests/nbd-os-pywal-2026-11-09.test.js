/**
 * tests/nbd-os-pywal-2026-11-09.test.js - NBD OS P3 #12, wallpaper to palette
 * (pywal-style, inside the brand lock; documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §6 #12).
 *
 * When a TENANT (never the platform tenant, NBD) shows one of its own My Skin
 * pictures as the OS wallpaper, the OS home surfaces get a wash of the picture's
 * hue in --s and --s2 (and only those), accepted only while every
 * text-on-surface pair stays >= 4.5:1; otherwise the theme's own tokens stay.
 *
 *   1. contrast guard: os/wallpaper-logic.js surfaceTint over every theme in
 *      theme-system.css x a spread of pictures: every accepted wash keeps --t and
 *      --m >= 4.5:1 on --s, --s2, the 88% widget glass and the 70% hover over the
 *      veiled picture (recomputed here, independently), and the theme accent does
 *      not blend in further than accentCheck's 3:1; it only ever returns s / s2
 *   2. fallback: a grey picture, unreadable tokens, a theme whose own text fails,
 *      no My Skin logic -> no wash (ok:false); allowed() needs a KNOWN identity that
 *      is exactly not the platform tenant, no company-enforced background, switch on
 *   3. the member's switch: os-home tint (absent = on), carried by every key op,
 *      inside the 12,000-char budget
 *   4. in the running layout (fake DOM, the real os.js + oswp bundle): a tenant's
 *      picture sets --os-pal-s / --os-pal-s2 + data-os-pal on the surface only; the
 *      picker's switch saves tint:false in one saveUser and takes the wash off at
 *      once; a theme change re-decides; a theme whose text would fail keeps its own
 *   5. NBD byte-identical: the platform tenant (and an unknown identity, and a
 *      company-enforced background) gets exactly what P1 painted: the same surface
 *      properties and attributes as with no palette code at all, no picker switch,
 *      and the picture is never even sampled
 *   6. scope: the CSS maps --os-pal-* onto --s / --s2 only, only under
 *      [data-os-pal] home surfaces (never .os-wins, <html>, <body> or a dialog);
 *      nothing outside the OS files mentions it (documents, docgen, PDFs, emails,
 *      the public site); no style attribute; lazy (no boot tag, no needs path)
 *
 * Run: node tests/nbd-os-pywal-2026-11-09.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, read, makeWin, fire, noComments } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 600) : '')); }
}
const J = (v) => JSON.stringify(v);
const G = (fn) => { try { fn(); } catch (e) { ok('section ran without throwing', false, e && e.stack); } };
const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 10; i++) await tick(); };

const L = require(path.join(ROOT, 'docs/pro/js/my-skin-logic.js'));
const HL = require(path.join(ROOT, 'docs/pro/js/os/home-logic.js'));
const R = require(path.join(ROOT, 'docs/pro/js/layout-system.js'));
let P = null;
try { P = require(path.join(ROOT, 'docs/pro/js/os/wallpaper-logic.js')); } catch (e) { P = null; }

// every theme's tokens, from the real stylesheet
function themes() {
  const css = read('docs/pro/css/theme-system.css');
  const re = /:root\[data-theme="([a-z0-9-]+)"\]\s*\{([^}]*)\}/g;
  const out = [];
  let m;
  while ((m = re.exec(css))) {
    const v = {};
    m[2].split(';').forEach((p) => { const i = p.indexOf(':'); if (i > 0) v[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
    out.push({ id: m[1], tok: { s: L.toHex(v['--s']), s2: L.toHex(v['--s2']), t: L.toHex(v['--t']), m: L.toHex(v['--m']), bg: L.toHex(v['--bg']), accent: L.toHex(v['--orange']),
      more: ['--red', '--green', '--gold', '--blue', '--purple'].map((k) => L.toHex(v[k] || '')).filter(Boolean) } });
  }
  return out.filter((t) => ['s', 's2', 't', 'm', 'bg'].every((k) => t.tok[k]));
}
function flat(r, g, b) { const a = []; for (let i = 0; i < 1024; i++) a.push(r, g, b, 255); return a; }
function rnd(seed) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; }; }
function photo(seed) {   // a busy picture: two colour fields and noise
  const r = rnd(seed), a = [];
  const c1 = [r() * 255, r() * 255, r() * 255], c2 = [r() * 255, r() * 255, r() * 255];
  for (let i = 0; i < 1024; i++) { const c = (i % 32) < 16 ? c1 : c2; a.push(...c.map((v) => Math.max(0, Math.min(255, Math.round(v + (r() - 0.5) * 60)))), 255); }
  return a;
}
const PICS = [flat(40, 90, 200), flat(40, 160, 70), flat(230, 120, 40), flat(220, 60, 160), flat(250, 250, 250), flat(5, 5, 5),
  flat(200, 40, 40), flat(60, 200, 200), flat(120, 60, 200)];
for (let i = 1; i <= 24; i++) PICS.push(photo(i * 7919));

(async () => {
  // ═════════════════════════════════════════════════════════════════════
  console.log('\n1. contrast guard: every accepted wash keeps every text pair at 4.5:1');
  G(() => {
    ok('os/wallpaper-logic.js exists and exports allowed / avgOf / surfaceTint', !!P && ['allowed', 'avgOf', 'surfaceTint'].every((k) => typeof P[k] === 'function'));
    if (!P) return;
    const TH = themes();
    ok('the real theme tokens were read (' + TH.length + ' themes)', TH.length >= 30, TH.length);
    let accepted = 0, refused = 0;
    const bad = [];
    [0, 0.3, 0.55, 0.85].forEach((dim) => {
      TH.forEach((th) => {
        PICS.forEach((pic, pi) => {
          const r = P.surfaceTint(th.tok, pic, L, { dim });
          if (!r.ok) { refused++; return; }
          accepted++;
          const avg = P.avgOf(pic);
          const behind = L.mixHex(th.tok.bg, avg, dim);
          const grounds = [r.s, r.s2, L.mixHex(r.s, behind, 0.88), L.mixHex(r.s2, behind, 0.7)];
          const min = Math.min(...grounds.map((g) => Math.min(L.contrast(th.tok.t, g), L.contrast(th.tok.m, g))));
          if (min < 4.5) bad.push(th.id + '/' + pi + '/' + dim + ' min ' + min.toFixed(2));
          // every other theme colour (the accent, red, green, gold, blue, purple): a pair at
          // 4.5:1 or better on a ground stays there, and one at the 3:1 UI floor stays at it
          const grounds0 = [th.tok.s, th.tok.s2, L.mixHex(th.tok.s, behind, 0.88), L.mixHex(th.tok.s2, behind, 0.7)];
          [th.tok.accent].concat(th.tok.more).filter(Boolean).forEach((fg) => {
            grounds0.forEach((g0, gi) => {
              const before = L.contrast(fg, g0), after = L.contrast(fg, grounds[gi]);
              const keep = before >= 4.5 ? 4.5 : before >= 3 ? 3 : 0;
              if (after < keep - 1e-9) bad.push(th.id + '/' + pi + '/' + dim + ' ' + fg + ' on ground ' + gi + ' ' + before.toFixed(2) + '->' + after.toFixed(2));
            });
          });
          if (th.tok.accent) {
            const a0 = L.accentCheck(th.tok.accent, th.tok.s).ui, a1 = L.accentCheck(th.tok.accent, r.s).ui;
            if (a1 < Math.min(3, a0) - 1e-9) bad.push(th.id + '/' + pi + ' accent ' + a0.toFixed(2) + '->' + a1.toFixed(2));
          }
          if (!/^#[0-9a-f]{6}$/.test(r.s) || !/^#[0-9a-f]{6}$/.test(r.s2)) bad.push(th.id + ' not hex ' + r.s + ' ' + r.s2);
        });
      });
    });
    ok('no accepted wash puts --t or --m under 4.5:1 on any ground, drops another theme colour below a 4.5:1 or 3:1 line it met, nor lets the accent blend in further (' + accepted + ' accepted, ' + refused + ' fell back)', bad.length === 0, bad.slice(0, 8).join('; '));
    ok('the guard is not vacuous: it accepts some and refuses some', accepted > 100 && refused > 100, accepted + '/' + refused);
    const nbdTheme = TH.filter((t) => t.id === 'nbd-original')[0];
    const r = P.surfaceTint(nbdTheme.tok, PICS[0], L, { dim: 0.6 });
    ok('a result carries the two tokens and nothing else to paint (s, s2; hue/share/min are for the test)', r.ok && J(Object.keys(r).sort()) === J(['hue', 'min', 'ok', 's', 's2', 'share']), J(r));
    ok('it is deterministic: the same picture and theme give the same wash', J(P.surfaceTint(nbdTheme.tok, PICS[0], L, { dim: 0.6 })) === J(r));
    ok('the wash keeps the theme recognisable: --s moves by at most the strongest share toward the hue at its own lightness', r.ok && r.share <= Math.max(...P.SHARES) && L.contrast(r.s, nbdTheme.tok.s) < 1.3, r.s + ' vs ' + nbdTheme.tok.s);
  });

  // ═════════════════════════════════════════════════════════════════════
  console.log('\n2. fallback, and who gets a wash at all');
  G(() => {
    if (!P) { ok('wallpaper-logic exists', false); return; }
    const tok = { s: '#1a3057', s2: '#0f2847', t: '#e2e8f0', m: '#acb2bc', bg: '#19305a', accent: '#bd5728' };
    ok('a grey picture: no colour to follow, no wash', P.surfaceTint(tok, flat(128, 128, 128), L, { dim: 0.55 }).why === 'grey');
    ok('an empty or missing sample: no wash', !P.surfaceTint(tok, [], L, {}).ok && !P.surfaceTint(tok, null, L, {}).ok);
    ok('a token that is not a colour (an unset var, a gradient): no wash', P.surfaceTint(Object.assign({}, tok, { s: null }), PICS[0], L, {}).why === 'tokens' && !P.surfaceTint(Object.assign({}, tok, { m: 'linear-gradient(x)' }), PICS[0], L, {}).ok);
    ok('no My Skin logic: no wash', P.surfaceTint(tok, PICS[0], null, {}).why === 'no-logic' && P.surfaceTint(tok, PICS[0], {}, {}).why === 'no-logic');
    const weak = Object.assign({}, tok, { m: '#5a6070' });   // muted text already under 4.5:1 on the theme's own surface
    ok('a theme whose own muted text is under 4.5:1: every share is refused (contrast), the theme stays as it is', P.surfaceTint(weak, PICS[0], L, { dim: 0.55 }).why === 'contrast');
    ok('avgOf: the mean of the opaque pixels', P.avgOf([255, 0, 0, 255, 0, 0, 255, 255, 9, 9, 9, 0]) === '#800080' && P.avgOf([1, 2, 3, 0]) === null && P.avgOf(null) === null);
    const A = P.allowed;
    ok('allowed: a known tenant identity, not the platform tenant, switch on', A({ nbd: false, known: true }) === true && A({ nbd: false, known: true, on: true, locked: false }) === true);
    ok('never the platform tenant (NBD)', A({ nbd: true, known: true }) === false);
    ok('never an unknown identity (claims not read yet, or read for another account), whatever nbd says', A({ nbd: false, known: false }) === false && A({ nbd: null, known: true }) === false && A({}) === false && A(null) === false);
    ok('a company-enforced My Skin background wins', A({ nbd: false, known: true, locked: true }) === false);
    ok('the member\'s switch off', A({ nbd: false, known: true, on: false }) === false);
  });

  // ═════════════════════════════════════════════════════════════════════
  console.log('\n3. the member\'s switch in the os-home key');
  G(() => {
    ok('home-logic exports tintOf / setTint', typeof HL.tintOf === 'function' && typeof HL.setTint === 'function');
    if (typeof HL.tintOf !== 'function') return;
    const d = HL.defaults();
    const base = { v: 1, phone: d.phone, desk: d.desk, wp: { phone: 'lq3x9a1b2c', desk: null } };
    ok('absent = on (the default for a tenant), and a key without it normalises unchanged', HL.tintOf(base) === true && HL.tintOf(null) === true && !('tint' in HL.normalize(base)));
    const off = HL.setTint(base, false);
    ok('setTint(false): tint:false, the widgets and wallpaper kept', off.tint === false && HL.tintOf(off) === false && J(off.wp) === J(base.wp) && J(off.phone) === J(HL.normalize(base).phone), J(off));
    ok('setTint(true) takes it out of the key again', !('tint' in HL.setTint(off, true)) && HL.tintOf(HL.setTint(off, true)) === true);
    ok('only false is kept (a string, 0 or null is not "off")', !('tint' in HL.normalize(Object.assign({}, base, { tint: 'false' }))) && !('tint' in HL.normalize(Object.assign({}, base, { tint: 0 }))));
    const ops = {
      normalize: HL.normalize(off), setWp: HL.setWp(off, 'desk', 'tod'), setSurface: HL.setSurface(off, 'phone', d.phone),
      setActOn: HL.setActOn(off, 'phone', HL.ACT_PRESETS[0].id), renameAct: HL.renameAct(off, HL.ACT_PRESETS[0].id, 'Mine'),
    };
    const lost = Object.keys(ops).filter((k) => !ops[k] || ops[k].tint !== false);
    ok('every key op carries it (normalize, setWp, setSurface, setActOn, renameAct)', lost.length === 0, lost.join());
    ok('a member on the company home stays on it after switching (no lists copied in)', J(HL.setTint(null, false)) === J({ v: 1, tint: false }));
    ok('it survives LayoutRegistry.normalizeUser', R.normalizeUser({ layoutState: { 'os-home': off } }).layoutState['os-home'].tint === false);
    const fill = []; for (let i = 0; i < 30; i++) fill.push({ id: 'coach', s: 'm', cfg: { show: 'business' } });
    const big = HL.setTint(HL.normalize({ v: 1, phone: fill, desk: fill, wp: { phone: 'z'.repeat(16), desk: 'y'.repeat(16) } }), false);
    ok('the max-fill key with the switch off still fits the 12,000-char budget (' + J(big).length + ')', J(big).length < 12000 && J(big).length <= R.MAX_STATE_JSON);
  });

  // ═════════════════════════════════════════════════════════════════════
  // the running layout
  const PIC = 'lq3x9a1b2c';
  const NBD_TOK = { '--s': '#1A3057', '--s2': '#0f2847', '--t': '#e2e8f0', '--m': '#acb2bc', '--bg': '#19305a', '--orange': '#BD5728' };
  function setup(o) {
    o = o || {};
    const T = makeWin(Object.assign({ surface: 'phone', system: true, claims: o.claims || { role: 'owner', companyId: 'c1' },
      home: o.home || { phone: [{ id: 'glance', s: 'm' }], desk: [{ id: 'glance', s: 'm' }], wp: { phone: PIC, desk: PIC } } }, o));
    const W = T.W;
    W.loads = [];
    W.ScriptLoader = {
      bundles: {},
      loadBundle(name) {
        W.loads.push(name);
        (this.bundles[name] || []).forEach((f) => { const p = 'docs/pro/' + f.replace(/\?.*$/, ''); if (o.noPalette && /wallpaper-logic/.test(p)) return; vm.runInContext(read(p), W, { filename: p }); });
        return Promise.resolve();
      },
    };
    vm.runInContext(read('docs/pro/js/my-skin-logic.js'), W, { filename: 'my-skin-logic.js' });
    let n = 0;
    W.URL = { createObjectURL: () => 'blob:https://app.test/' + (++n), revokeObjectURL: () => {} };
    W.NBDMySkin = {
      state: () => ({ cfg: { hidePictures: false } }),
      images: () => [{ id: PIC, theme: 'nbd-original', w: 9, h: 9, thumb: false }],
      imageBlob: () => Promise.resolve({ blob: { size: 9 }, dim: 0.62 }),
    };
    W._isNbdPlatformTenant = () => (o.nbd === undefined ? false : o.nbd);
    W.tok = Object.assign({}, NBD_TOK, o.tok || {});
    W.getComputedStyle = () => ({ display: 'block', getPropertyValue: (k) => W.tok[k] || '' });
    W.sampled = 0;
    W.createImageBitmap = () => { W.sampled++; return Promise.resolve({ close() {} }); };
    const mk = W.document.createElement;
    W.document.createElement = (t) => (t === 'canvas'
      ? { getContext: () => ({ drawImage() {}, getImageData: () => ({ data: o.sample || PICS[0] }) }) }
      : mk(t));
    if (o.locked) W.document.documentElement.classList.add('my-skin-locked');
    return T;
  }
  function rec(el) {
    const props = {};
    el.style = { setProperty(k, v) { props[k] = v; }, removeProperty(k) { delete props[k]; } };
    return props;
  }
  const htmlRec = (T) => rec(T.document.documentElement);
  const bodyRec = (T) => rec(T.document.body);
  async function mounted(o) {
    const T = setup(o);
    const hp = htmlRec(T), bp = bodyRec(T);
    T.W._impl.mount({ surface: (o && o.surface) || 'phone' });
    const el = T.document.getElementById((o && o.surface) === 'desktop' ? 'osDesk' : 'osPhone');
    const props = rec(el);
    await flush();
    return { T, el, props, hp, bp };
  }
  const attrsOf = (el) => { const a = Object.assign({}, el.attrs); return a; };

  console.log('\n4. a tenant\'s picture washes the OS home surfaces');
  {
    const { T, el, props, hp, bp } = await mounted({});
    ok('the oswp bundle carries the logic file ahead of the painter (runtime ScriptLoader bundle)', J(T.W.ScriptLoader.bundles.oswp) === J(['js/os/wallpaper-logic.js?v=1', 'js/os/wallpaper.js?v=2']), J(T.W.ScriptLoader.bundles));
    ok('the picture shows (P1) and was sampled once', el.getAttribute('data-os-wp') === 'img' && T.W.sampled === 1, J({ wp: el.getAttribute('data-os-wp'), sampled: T.W.sampled }));
    const want = P && P.surfaceTint({ s: '#1a3057', s2: '#0f2847', t: '#e2e8f0', m: '#acb2bc', bg: '#19305a', accent: '#bd5728' }, PICS[0], L, { dim: 0.62 });
    ok('--os-pal-s / --os-pal-s2 are the guarded wash, data-os-pal is on the surface', want && want.ok && props['--os-pal-s'] === want.s && props['--os-pal-s2'] === want.s2 && el.getAttribute('data-os-pal') === '', J({ props, want }));
    ok('only those two and the P1 picture properties are set on the surface', J(Object.keys(props).sort()) === J(['--os-pal-s', '--os-pal-s2', '--os-wp-dim', '--os-wp-img']), J(Object.keys(props)));
    ok('nothing lands on <html> or <body> (the CRM, documents and dialogs keep the theme)', Object.keys(hp).length === 0 && Object.keys(bp).length === 0 && !T.document.documentElement.hasAttribute('data-os-pal'), J({ hp, bp }));
    ok('never a style attribute', !('style' in el.attrs));
    // the theme changes: decided again against the new tokens
    T.W.tok = Object.assign({}, NBD_TOK, { '--s': '#0b1024', '--s2': '#141a36', '--t': '#e2e8f0', '--m': '#7e88a8', '--bg': '#070b1a', '--orange': '#6366F1' });
    (T.W.document.listeners.themechange || []).forEach((f) => f({ type: 'themechange' }));
    const want2 = P.surfaceTint({ s: '#0b1024', s2: '#141a36', t: '#e2e8f0', m: '#7e88a8', bg: '#070b1a', accent: '#6366f1' }, PICS[0], L, { dim: 0.62 });
    ok('a theme change re-decides the wash against the new theme, with no new sample', (want2.ok ? props['--os-pal-s'] === want2.s : !props['--os-pal-s']) && T.W.sampled === 1, J({ props, want2 }));
    // a theme whose muted text would fail: the theme keeps its own
    T.W.tok = Object.assign({}, NBD_TOK, { '--m': '#5a6070' });
    (T.W.document.listeners.themechange || []).forEach((f) => f({ type: 'themechange' }));
    ok('fallback: a theme whose text would fail keeps its own --s / --s2 (no wash, no data-os-pal)', !('--os-pal-s' in props) && !('--os-pal-s2' in props) && !el.hasAttribute('data-os-pal'), J(props));
    T.W.tok = Object.assign({}, NBD_TOK);
    (T.W.document.listeners.themechange || []).forEach((f) => f({ type: 'themechange' }));
    ok('…and back on a readable theme the wash returns', props['--os-pal-s'] === want.s && el.getAttribute('data-os-pal') === '');

    // the switch in the picker
    const c = (T.W.controls || []).filter((x) => x.id === 'os-wallpaper')[0];
    c.run(); await flush();
    const d = T.document.querySelector('dialog.os-wp-pick');
    const box = d && d.querySelector('[data-oswp-tint]');
    ok('the picker shows "Colour my widgets from my picture", checked (on by default)', !!box && box.hasAttribute('checked') && /Colour my widgets from my picture/.test(d.textContent) && /Never on documents/.test(d.textContent));
    const saves0 = (T.W._saves || []).length;
    box.checked = false; fire(T.dom, box, 'change');
    await flush();
    const s = (T.W._saves || []).slice(saves0);
    ok('turning it off: one saveUser of os-home with tint:false, the wallpaper kept', s.length === 1 && s[0].layoutState['os-home'].tint === false && J(s[0].layoutState['os-home'].wp) === J({ phone: PIC, desk: PIC }), J(s));
    ok('…and the wash is off at once (the picture stays)', !('--os-pal-s' in props) && !el.hasAttribute('data-os-pal') && el.getAttribute('data-os-wp') === 'img', J(props));
    T.fire(30000); await flush();
    ok('…the clock tick does not bring it back', !('--os-pal-s' in props));
    box.checked = true; fire(T.dom, box, 'change');
    await flush();
    const s2 = (T.W._saves || []).slice(saves0 + 1);
    ok('turning it on again: tint leaves the key and the wash is back', s2.length === 1 && !('tint' in s2[0].layoutState['os-home']) && props['--os-pal-s'] === want.s, J({ s2, props }));
    T.W._impl.unmount();

    const off = await mounted({ home: { phone: [{ id: 'glance', s: 'm' }], desk: [], wp: { phone: PIC, desk: null }, tint: false } });
    ok('a member who turned it off: the picture shows, no wash, and it is not even sampled', off.el.getAttribute('data-os-wp') === 'img' && !off.el.hasAttribute('data-os-pal') && !('--os-pal-s' in off.props) && off.T.W.sampled === 0);

    const desk = await mounted({ surface: 'desktop' });
    ok('the desk gets the same wash on #osDesk (the CSS scopes it to its home parts)', desk.el.getAttribute('data-os-pal') === '' && desk.props['--os-pal-s'] === want.s, J(desk.props));
    const grey = await mounted({ sample: flat(128, 128, 128) });
    ok('a grey picture: the picture shows, no wash', grey.el.getAttribute('data-os-wp') === 'img' && !grey.el.hasAttribute('data-os-pal') && !('--os-pal-s' in grey.props));
    const late = await mounted({ claims: { role: 'owner' } });
    ok('claims not read yet (no companyId): no wash, no sample', !late.el.hasAttribute('data-os-pal') && late.T.W.sampled === 0);
    late.T.W._userClaims = { role: 'owner', companyId: 'c1' };
    late.T.fire(30000); await flush();
    ok('…the claims arrive: the next clock tick samples once and washes', late.el.getAttribute('data-os-pal') === '' && late.T.W.sampled === 1 && late.props['--os-pal-s'] === want.s, J({ s: late.T.W.sampled, p: late.props }));
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('\n5. NBD stays byte-identical');
  {
    const snap = (m) => J({ props: m.props, attrs: attrsOf(m.el), html: m.hp, body: m.bp, htmlAttrs: attrsOf(m.T.document.documentElement) });
    const before = await mounted({ nbd: true, noPalette: true });   // P1: no palette code at all
    const nbd = await mounted({ nbd: true });
    ok('the platform tenant: the surface carries exactly what P1 painted (same properties, same attributes)', snap(nbd) === snap(before), snap(nbd) + '\n      vs ' + snap(before));
    ok('…no --os-pal-*, no data-os-pal, and the picture is never sampled', !('--os-pal-s' in nbd.props) && !nbd.el.hasAttribute('data-os-pal') && nbd.T.W.sampled === 0);
    nbd.T.fire(30000); await flush();
    (nbd.T.W.document.listeners.themechange || []).forEach((f) => f({ type: 'themechange' }));
    ok('…nor after a clock tick or a theme change', snap(nbd) === snap(before) && nbd.T.W.sampled === 0);
    const c = (nbd.T.W.controls || []).filter((x) => x.id === 'os-wallpaper')[0];
    c.run(); await flush();
    const d = nbd.T.document.querySelector('dialog.os-wp-pick');
    ok('…and its picker has no colour switch (nothing to turn on)', !!d && !d.querySelector('[data-oswp-tint]') && !/Colour my widgets/.test(d.textContent));
    const nbdEmp = await mounted({ nbd: true, claims: { role: 'sales_rep', companyId: '1phDvAVXHSg82wDLegAbQFq14Ci1' } });
    ok('an NBD employee (claims companyId = the platform tenant): the same', !nbdEmp.el.hasAttribute('data-os-pal') && nbdEmp.T.W.sampled === 0);
    const unknown = await mounted({ nbd: null });
    ok('an identity the CRM can\'t place: no wash', !unknown.el.hasAttribute('data-os-pal') && unknown.T.W.sampled === 0);
    const locked = await mounted({ locked: true });
    ok('a company-enforced My Skin background: no picture, no wash (it wins)', !locked.el.hasAttribute('data-os-pal') && !('--os-pal-s' in locked.props) && locked.T.W.sampled === 0);
    // the stylesheet: with no data-os-pal, no rule touches --s / --s2
    const css = noComments(read('docs/pro/css/layouts/os.css') + '\n' + read('docs/pro/css/os/home.css'));
    const setsS = css.split('}').filter((b) => /(^|[;{\s])--s2?\s*:/.test(b));
    ok('the OS stylesheets set --s / --s2 in exactly one rule, and it needs data-os-pal', setsS.length === 1 && /\[data-os-pal\]/.test(setsS[0]), J(setsS));
    ok('docgen-brand\'s files are untouched by this lane (no os-pal in them)', ['docs/pro/js/document-generator-templates.js', 'docs/pro/js/document-generator.js', 'functions/render-pdf.js'].every((f) => !/os-pal|NBDOSWallpaperLogic/.test(read(f))));
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('\n6. scope: no token leaks outside the OS root');
  G(() => {
    const css = noComments(read('docs/pro/css/layouts/os.css'));
    const rule = (css.match(/@media[^{]*\{[^{}]*\{[^}]*--os-pal-s[^}]*\}\s*\}/) || [''])[0];
    ok('the rule sits under @media (prefers-contrast: no-preference) and (forced-colors: none)', /@media \(prefers-contrast: no-preference\) and \(forced-colors: none\)/.test(rule), rule);
    const body = (rule.match(/\{([^{}]*)\}\s*\}$/) || [])[1] || '';
    const decls = body.split(';').map((x) => x.trim()).filter(Boolean);
    ok('it sets --s and --s2 from --os-pal-s / --os-pal-s2 and nothing else', J(decls) === J(['--s: var(--os-pal-s)', '--s2: var(--os-pal-s2)']), J(decls));
    const sels = (rule.replace(/^@media[^{]*\{/, '').split('{')[0] || '').split(/,(?![^(]*\))/).map((x) => x.trim()).filter(Boolean);
    ok('two selectors: the phone home (#osPhone) and the desk\'s widget column / taskbar / Start', sels.length === 2 && /\.os-phone\[data-os-pal\]\[data-os-wp="img"\]$/.test(sels[0]) && /\.os-desk\[data-os-pal\]\[data-os-wp="img"\] :is\(\.os-widgets, \.os-taskbar, \.os-start\)$/.test(sels[1]), J(sels));
    ok('…each only while no Sunlight, no company-enforced background, no high-contrast theme', sels.every((s) => /^html:not\(\.sun-all\):not\(\.my-skin-locked\):not\(\[data-theme="high-contrast"\]\) /.test(s)), J(sels));
    ok('…never a window (.os-wins / .os-win: the CRM\'s views, documents, previews), :root, body or a dialog', sels.every((s) => !/os-wins?\b|:root|\bbody\b|dialog/.test(s)));
    const WP = read('docs/pro/js/os/wallpaper.js');
    const sets = (noComments(WP).match(/style\.setProperty\(\s*'[^']+'/g) || []).map((x) => x.replace(/.*'([^']+)'$/, '$1'));
    ok('wallpaper.js sets only --os-wp-* and --os-pal-* custom properties', sets.length && sets.every((p) => /^--os-(wp|pal)-/.test(p)), J(sets));
    ok('…and only on the surface it was handed (h.el / el), never documentElement or body', !/documentElement\.style|body\.style/.test(noComments(WP)));
    // every file that mentions the palette is one of the OS lane's own
    const hits = [];
    (function walk(d) {
      fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).forEach((e) => {
        const p = d + '/' + e.name;
        if (e.isDirectory()) { if (!/node_modules|vendor/.test(e.name)) walk(p); return; }
        if (!/\.(js|mjs|css|html|json)$/.test(e.name)) return;
        if (/os-pal|NBDOSWallpaperLogic|wallpaper-logic/.test(fs.readFileSync(path.join(ROOT, p), 'utf8'))) hits.push(p);
      });
    })('docs');
    ['functions', 'site-src'].forEach((d) => { if (fs.existsSync(path.join(ROOT, d))) (function walk(dd) {
      fs.readdirSync(path.join(ROOT, dd), { withFileTypes: true }).forEach((e) => {
        const p = dd + '/' + e.name;
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); return; }
        if (/\.(js|mjs|css|html)$/.test(e.name) && /os-pal|NBDOSWallpaperLogic/.test(fs.readFileSync(path.join(ROOT, p), 'utf8'))) hits.push(p);
      });
    })(d); });
    const allowedFiles = ['docs/pro/js/os/wallpaper-logic.js', 'docs/pro/js/os/wallpaper.js', 'docs/pro/js/layouts/os.js', 'docs/pro/css/layouts/os.css'];
    ok('only the OS files mention it: never documents, docgen, PDFs, emails or the public site', hits.every((h) => allowedFiles.indexOf(h) !== -1), J(hits));
    ['docs/pro/js/os/wallpaper-logic.js', 'docs/pro/js/os/wallpaper.js'].forEach((f) => ok(f + ': no style="…", no inline handler', !/style="|\son[a-z]+=/.test(read(f))));
    ok('lazy: no <script> tag for it and no needs path (the oswp bundle is registered at runtime)', !/wallpaper-logic/.test(read('docs/pro/dashboard.html')) && !/wallpaper-logic/.test(read('docs/pro/js/layout-system.js')));
    ok('wallpaper-logic.js does no I/O (no fetch, Firestore, storage, timers or DOM)', !/fetch\(|getDoc|setDoc|localStorage|setTimeout|setInterval|document\./.test(noComments(read('docs/pro/js/os/wallpaper-logic.js'))));
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('  ✗ the suite threw: ' + (e && e.stack)); process.exit(1); });
