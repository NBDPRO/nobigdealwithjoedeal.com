/**
 * tests/custom-theme-2026-11-17.test.js
 *
 * A saved custom theme (five free colours) is drawn from all five, the same way in Daily Success and the Workout app
 * (docs/pro/daily-success/js/custom-theme-logic.js). Before this Daily Success applied only the page, the bar and the accent:
 * the text and muted colours were dropped, cards stayed cream and body text was black on whatever page colour was picked.
 *
 *   1. What counts as a custom theme (a custom id, five six-digit hex colours; nothing else is kept).
 *   2. derive(): readable whatever was picked. 400 random themes, every text colour measured against the surface it sits on,
 *      including the surfaces that stay dark in every skin. Readable picks are used exactly as chosen.
 *   3. Those fixed-dark surfaces are the real ones in the stylesheets and app.js.
 *   4. app.js lays the whole token row for a custom theme and takes it off for the next theme.
 *   5. accent-ui.js: with no accent picked a custom theme keeps its own (derived) accent colours; a picked accent still wins.
 *   6. The three page rules that assumed a built-in skin, and the script order on both pages.
 *
 * Run: node tests/custom-theme-2026-11-17.test.js
 */
'use strict';

const kit = require('./lib/src-kit');
const CT = require('../docs/pro/daily-success/js/custom-theme-logic.js');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const mk = (n, accent, bg, s, tc, m, name) => ({ id: 'custom-170000000000' + n, name: name || 'Custom ' + n, cat: 'custom', plan: 'command', accent, bg, s, tc, m });
const DARK = mk(1, '#22aa66', '#101820', '#1c2836', '#f0f0f0', '#99aabb');
const LIGHT = mk(2, '#aa2266', '#f4f1ea', '#ffffff', '#221a12', '#6a5f55');
const SPLIT = mk(3, '#e0a030', '#f4f1ea', '#3a2f25', '#221a12', '#6a5f55');   // a light page with dark cards
const PALE = mk(4, '#ffe066', '#0b0b0f', '#17171f', '#eeeeee', '#9090a0');    // an accent white text cannot sit on
const BAD = mk(5, '#333333', '#222222', '#2a2a2a', '#303030', '#2c2c2c');     // nothing readable as picked
const D = (c) => CT.derive(CT.normCustom(c));
const dsDoc = kit.parseTags(kit.read('docs/pro/daily-success/index.html'));
const dsCss = dsDoc.$$('style').map((s) => s.html).join('\n');

console.log('\n1. What counts as a custom theme');
{
  const good = { id: 'custom-1', name: 'X', accent: '#112233', bg: '#000000', s: '#111111', tc: '#FFFFFF', m: '#aaaaaa' };
  const bad = [null, 'x', [], Object.assign({}, good, { id: 'ocean' }), Object.assign({}, good, { id: 'custom-1; x' }), Object.assign({}, good, { id: 'custom-' }), Object.assign({}, good, { bg: 'red' }),
    Object.assign({}, good, { s: '#fff' }), Object.assign({}, good, { accent: 'url(javascript:1)' }), Object.assign({}, good, { tc: '#12345g' }), Object.assign({}, good, { m: null }), Object.assign({}, good, { bg: '#000000;--x:1' })];
  ok('a custom id and five six-digit hex colours; anything else is not a theme', bad.every((c) => CT.normCustom(c) === null) && CT.normCustom(good) !== null);
  const n = CT.normCustom(Object.assign({}, good, { evil: 1, cat: 'custom', plan: 'command', name: '  a   b ' + 'z'.repeat(80) }));
  ok('only id, name and the five colours are kept; colours lower-cased, the name tidied', Object.keys(n).join() === 'id,name,accent,bg,s,tc,m' && n.tc === '#ffffff' && n.name.length === 40 && n.name.indexOf('a b ') === 0);
  ok('a missing or odd name becomes "Custom"', CT.normCustom(Object.assign({}, good, { name: 7 })).name === 'Custom' && CT.normCustom(Object.assign({}, good, { name: '   ' })).name === 'Custom');
  ok('the stored list: bad entries and repeats dropped, junk tolerated', CT.parseList(JSON.stringify([good, bad[6], good, Object.assign({}, good, { id: 'custom-2' })])).map((c) => c.id).join() === 'custom-1,custom-2'
    && CT.parseList('not json').length === 0 && CT.parseList(null).length === 0 && CT.parseList('{"a":1}').length === 0);
  ok('only custom ids are custom ids', CT.isCustomId('custom-1700000000001') && !CT.isCustomId('ocean') && !CT.isCustomId('custom-x') && !CT.isCustomId(null));
}

console.log('\n2. derive(): readable whatever was picked');
{
  let seed = 20261117;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x80000000; };
  const hex = () => '#' + [0, 0, 0].map(() => Math.floor(rnd() * 256).toString(16).padStart(2, '0')).join('');
  const worst = {};
  const low = (k, v) => { if (!(k in worst) || v < worst[k]) worst[k] = v; };
  let keptInk = 0, keptFill = 0, keptBar = 0, deepest = 0;
  for (let i = 0; i < 400; i++) {
    const c = { id: 'custom-9', name: 'r', accent: hex(), bg: hex(), s: hex(), tc: hex(), m: hex() };
    const d = CT.derive(c), paper = d['--paper'], bar = d['--bar'];
    ['--ink', '--muted', '--ac-text', '--gold', '--grn', '--blu', '--pur', '--stxt', '--ghost', '--ph'].forEach((p) => low(p + ' on the cards', CT.contrast(d[p], paper)));
    [bar].concat(CT.FIXED_DARK).forEach((dk, n) => { low('--on-dark on ' + (n ? 'a fixed dark surface' : 'the bar'), CT.contrast(d['--on-dark'], dk)); low('--ac-on-dark on ' + (n ? 'a fixed dark surface' : 'the bar'), CT.contrast(d['--ac-on-dark'], dk)); });
    low('white on an accent-filled button', CT.contrast('#ffffff', d['--ac']));
    low('--page-ink on the page', CT.contrast(d['--page-ink'], c.bg)); low('--page-muted on the page', CT.contrast(d['--page-muted'], c.bg));
    low('--page-ac on the page', CT.contrast(d['--page-ac'], c.bg)); low('--footer on the page', CT.contrast(d['--footer'], c.bg));
    if (CT.contrast('#ffffff', bar) < 7) low('the bar is dark enough for light text', 0);
    if (d['--ink'] === c.tc) keptInk++;
    if (d['--ac'] === c.accent) keptFill++; else deepest = Math.max(deepest, CT.contrast('#ffffff', d['--ac']));
    if (bar === c.s) keptBar++;
  }
  const short = Object.keys(worst).filter((k) => worst[k] < 4.5);
  ok('every text colour is at least 4.5:1 on its own surface for each of 400 random themes (' + Object.keys(worst).length + ' pairings)', short.length === 0, short.map((k) => k + ' ' + worst[k].toFixed(2)).join('; '));
  ok('control: random picks are often unreadable or pale (the guards do real work), and good picks get through', keptInk > 20 && keptInk < 380 && keptFill > 20 && keptFill < 380 && keptBar > 20 && keptBar < 380, [keptInk, keptFill, keptBar].join());

  const d = D(DARK);
  ok('readable picks are used exactly as chosen: page, cards, text, muted, accent as text', d['--bg'] === '#101820' && d['--paper'] === '#1c2836' && d['--ink'] === '#f0f0f0' && d['--muted'] === '#99aabb' && d['--ac-text'] === '#22aa66' && d['--bar'] === '#1c2836', JSON.stringify(d));
  ok('an accent that carries white text is the button colour as picked', D(LIGHT)['--ac'] === '#aa2266');
  const pale = D(PALE)['--ac'], rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  ok('an accent too pale for white text is darkened, keeping its hue, until white reads on it', pale !== '#ffe066' && CT.contrast('#ffffff', pale) >= 4.5 && rgb(pale)[0] >= rgb(pale)[1] && rgb(pale)[1] > rgb(pale)[2] && D(PALE)['--ac-text'] === '#ffe066', pale);
  ok('...and no further than needed: across the 400, no darkened accent goes past 5.2:1', deepest >= 4.5 && deepest < 5.2, deepest.toFixed(2));
  const split = D(SPLIT);
  ok('a light page with dark cards: dark text on the page, light text on the cards, the dark surface is the bar', split['--page-ink'] === '#221a12' && split['--ink'] === '#ffffff' && split['--bar'] === '#3a2f25');
  const light = D(LIGHT);
  ok('light cards cannot be the bar: the theme\'s dark text colour is (as Warm Paper does)', light['--bar'] === '#221a12' && light['--paper'] === '#ffffff');
  ok('light cards and light text picked: the bar falls back to near-black', D(mk(7, '#2060c0', '#10141c', '#f2f2ee', '#f0f0f0', '#9aa4b4'))['--bar'] === '#12161c');
  const bad = D(BAD);
  ok('picks that cannot be read at all still come out readable', CT.contrast(bad['--ink'], bad['--paper']) >= 4.5 && CT.contrast(bad['--page-ink'], '#222222') >= 4.5 && CT.contrast('#ffffff', bad['--ac']) >= 4.5);
  ok('the result is the same every time, and has no property the pages do not know', JSON.stringify(D(DARK)) === JSON.stringify(D(DARK)) && Object.keys(d).every((p) => /^--[a-z-]+$/.test(p)) && Object.keys(d).length >= 25);
  ok('every value is a colour or a shadow: nothing a stylesheet could be broken out of', Object.keys(bad).concat(Object.keys(d)).every((p) => /^(#[0-9a-f]{6}|rgba\(\d{1,3},\d{1,3},\d{1,3},0?\.\d+\)|0 2px \d+px rgba\(0,0,0,\.\d+\))$/.test(d[p])));
}

console.log('\n3. The surfaces that stay dark in every skin are the real ones');
{
  const coach = kit.cssRule(kit.read('docs/pro/daily-success/css/workout-coach.css'), '.wc-ov') || {};
  const banner = kit.cssRule(dsCss, '.onboard-banner') || {};
  const glance = (kit.read('docs/pro/daily-success/js/app.js').match(/id="week-glance-wrap" style="background:(#[0-9a-fA-F]{6})/) || [])[1] || '';
  const real = [coach.background, banner.background, glance].map((v) => String(v || '').toLowerCase());
  ok('the coach logger, the onboarding banner and the week-glance panel', real.every((v) => /^#[0-9a-f]{6}$/.test(v)) && real.slice().sort().join() === CT.FIXED_DARK.slice().sort().join(), real.join() + ' vs ' + CT.FIXED_DARK.join());
}

console.log('\n4. app.js lays the whole row, and takes it off again');
{
  const APP = kit.read('docs/pro/daily-success/js/app.js');
  const inline = {};
  const ctx = { window: { NBDCustomTheme: CT }, document: { documentElement: { style: { setProperty: (p, v) => { inline[p] = v; }, removeProperty: (p) => { delete inline[p]; } } } } };
  require('vm').runInNewContext('let _nbdCustomLaid = [];\n' + kit.sliceFn(APP, '_nbdClearCustom') + '\n' + kit.sliceFn(APP, '_nbdLayCustom') + '\nthis.clear = _nbdClearCustom; this.lay = _nbdLayCustom;', ctx);
  ok('a custom theme gets every derived property', ctx.lay(DARK) === true && JSON.stringify(inline) === JSON.stringify(D(DARK)));
  inline['--fd'] = 'kept';   // something else app.js set inline (a font)
  ctx.clear();
  ok('the next theme starts clean: all of them come off, and nothing else does', JSON.stringify(inline) === '{"--fd":"kept"}');
  ok('a built-in theme, or a malformed custom one, lays nothing', ctx.lay({ id: 'ocean', cat: 'dark', accent: '#1F6FB5', bg: '#03101c', s: '#071a2c' }) === false && ctx.lay(Object.assign({}, DARK, { bg: 'red' })) === false && Object.keys(inline).length === 1);
  const apply = kit.sliceFn(APP, 'nbdApplyTheme');
  const at = (t) => apply.indexOf(t);
  ok('nbdApplyTheme clears first, sets its three colours, then lays the custom row over them', at('_nbdClearCustom();') > -1 && at('_nbdClearCustom();') < at("R.setProperty('--bar'") && at("R.setProperty('--bar'") < at('_nbdLayCustom(t);'));
  const boot = kit.sliceFn(APP, 'nbdBoot');
  ok('and a page that loads in a custom theme lays it at boot', boot.indexOf('_nbdLayCustom(t);') > boot.indexOf("R.setProperty('--bar'") && boot.indexOf("R.setProperty('--bar'") > -1);
}

console.log('\n5. The accent picker leaves a custom theme its own accent colours');
{
  function accentPage(theme, picked) {
    const inline = {};
    const html = { style: { setProperty: (p, v) => { inline[p] = v; }, removeProperty: (p) => { delete inline[p]; } } };
    const win = { NBDCustomTheme: CT, NBDLook: { changed: () => {} } };
    const store = picked ? { nbd_ds_accent: picked } : {};
    kit.loadInVm(['docs/pro/daily-success/js/accent-logic.js', 'docs/pro/daily-success/js/accent-ui.js'], { window: win,
      document: { documentElement: html, readyState: 'complete', addEventListener: () => {}, getElementById: () => null },
      localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
      getComputedStyle: () => ({ getPropertyValue: (p) => (p === '--paper' ? (inline['--paper'] || '') : '') }),
      MutationObserver: function () { this.observe = () => {}; },   // the picker re-applies when data-theme changes; not what is measured here
      _nbdGetTheme: () => theme, _nbd_activeTheme: theme.id });
    return { inline, A: win.NBDAccent, set: (id) => win.NBDAccent.set(id) };
  }
  const p = accentPage(PALE);
  const d = D(PALE);
  ok('no accent picked: buttons use the derived fill, not the raw pale colour', p.inline['--ac'] === d['--ac'] && p.inline['--orange'] === d['--ac'] && p.inline['--ac'] !== '#ffe066', JSON.stringify(p.inline));
  ok('and the accent-as-text colours it clears are put back from the theme', p.inline['--ac-text'] === d['--ac-text'] && p.inline['--ac-on-dark'] === d['--ac-on-dark']);
  const teal = p.A.ACCENTS.find((x) => x.id === 'teal');
  p.inline['--paper'] = d['--paper'];
  p.set('teal');
  ok('a picked accent still wins, tinted for the theme\'s cards', p.inline['--ac'] === teal.fill && p.inline['--ac-text'] === teal.onDark);
  p.set('');
  ok('taking it off again restores the theme\'s own', p.inline['--ac'] === d['--ac'] && p.inline['--ac-text'] === d['--ac-text']);
  const built = accentPage({ id: 'ocean', cat: 'dark', accent: '#1F6FB5', bg: '#03101c', s: '#071a2c' });
  ok('a built-in theme behaves as before: its own accent, and its text colours left to the stylesheet', built.inline['--ac'] === '#1F6FB5' && !('--ac-text' in built.inline) && !('--ac-on-dark' in built.inline));
}

console.log('\n6. Page rules and script order');
{
  const rule = (sel) => kit.cssRule(dsCss, sel) || {};
  ok('body text falls back to --ink, so the ten skins are unchanged', rule('body').color === 'var(--page-ink,var(--ink))', rule('body').color);
  ok('the accent words on the (always dark) banner use the on-dark accent', rule('.ob-msg span').color === 'var(--ac-on-dark,var(--ac-text,var(--ac)))', rule('.ob-msg span').color);
  ok('the "not earned" box sits on the page: under a custom theme its title and border take the page accent; the built-in rule is untouched',
    rule('[data-theme^="custom-"] .floor-egg.not-earned .floor-egg-title').color === 'var(--page-ac,var(--ac-text,#d97706))' && rule('[data-theme^="custom-"] .floor-egg.not-earned')['border-color'] === 'var(--page-ac,var(--ac-text,#d97706))'
    && rule('.floor-egg.not-earned .floor-egg-title').color === 'var(--ac-text,#d97706)', JSON.stringify(rule('[data-theme^="custom-"] .floor-egg.not-earned .floor-egg-title')));
  ok('a ghost button on the banner takes the on-dark colour, like the hero band and the coach', rule(':root .onboard-banner .btn-ghost').color === 'var(--on-dark,#c3cfdf)' && rule(':root .dhero .btn-ghost').color === 'var(--on-dark,#c3cfdf)');
  const order = (doc) => doc.$$('script').map((s) => String(s.attr('src') || '').split('?')[0].split('/').pop());
  const ds = order(dsDoc), wk = order(kit.parseTags(kit.read('docs/pro/workout/index.html')));
  const logicTag = dsDoc.$$('script').find((s) => String(s.attr('src') || '').indexOf('custom-theme-logic.js') > -1);
  ok('Daily Success loads the colour logic before app.js, not deferred (app.js uses it as it boots)', ds.indexOf('custom-theme-logic.js') > -1 && ds.indexOf('custom-theme-logic.js') < ds.indexOf('app.js') && !!logicTag && !logicTag.has('defer') && !logicTag.has('async'));
  ok('the Workout app loads it before its theme script', wk.indexOf('custom-theme-logic.js') > -1 && wk.indexOf('custom-theme-logic.js') < wk.indexOf('workout-theme.js'));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
