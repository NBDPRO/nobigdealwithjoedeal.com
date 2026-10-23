/**
 * tests/ds-accent-picker-2026-10-22.test.js
 *
 * Daily Success accent picker (roadmap Horizon 2 item 8): a short curated list of accents laid over the ten skins. Every accent
 * must read on EVERY skin, so this checks the whole accent x skin matrix with real WCAG maths:
 *   - white text on the fill >= 5:1 (buttons)
 *   - the accent as text (the tint chosen for that skin's card) >= 4.5:1 on the card and on the page
 *   - the on-dark tint >= 4.5:1 on the header bar, both tab-bar colours and the always-dark Floor Score panel
 *
 * Run: node tests/ds-accent-picker-2026-10-22.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DIR = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
const HTML = stripComments(fs.readFileSync(path.join(DIR, 'index.html'), 'utf8').replace(/\r\n/g, '\n'));
const APP = stripComments(fs.readFileSync(path.join(DIR, 'js', 'app.js'), 'utf8').replace(/\r\n/g, '\n'));
const UI = stripComments(fs.readFileSync(path.join(DIR, 'js', 'accent-ui.js'), 'utf8').replace(/\r\n/g, '\n'));
const A = require(path.join(DIR, 'js', 'accent-logic.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const ratio = (a, b) => { const x = A.lum(a), y = A.lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const readVars = (css) => { const o = {}; css.replace(/(--[a-z-]+)\s*:\s*([^;}]+)/g, (_, k, v) => { o[k] = v.trim(); return ''; }); return o; };

// --- the skins, parsed the same way the theme test does ---
const skins = {};
const defRow = (HTML.match(/\n\[data-theme="default"\]\{([^}]*)\}/) || [])[1] || '';
const baseRow = (HTML.match(/\n\[data-theme="dark"\][^{]*\{([^}]*)\}/) || [])[1] || '';
skins.default = Object.assign({}, readVars(baseRow), readVars(defRow));
for (const m of HTML.matchAll(/\n:root\[data-theme="([a-z-]+)"\]\{([^}]*)\}/g)) skins[m[1]] = readVars(m[2]);

/** Every failing pair for one accent on one skin. Empty array = the accent is safe there.
 *  A token that is missing or not a 6-digit hex FAILS (NaN < 4.5 is false, so an unchecked ratio would pass silently). */
function failures(a, k) {
  const out = [];
  ['fill', 'onLight', 'onDark'].forEach((f) => { if (!A.isHex(a[f])) out.push('accent ' + f + ' missing/unparseable'); });
  ['--paper', '--bg', '--bar', '--tabbar', '--taboff'].forEach((v) => { if (!A.isHex(k[v])) out.push('skin token ' + v + ' missing/unparseable'); });
  if (out.length) return out;
  const t = A.textFor(a, k['--paper']);
  const chk = (label, x, y, min) => { const r = ratio(x, y); if (!(r >= min)) out.push(label + ' ' + r.toFixed(2)); };
  chk('white/fill', '#ffffff', a.fill, 5);
  chk('text/card', t, k['--paper'], 4.5);
  chk('text/page', t, k['--bg'], 4.5);
  ['--bar', '--tabbar', '--taboff'].forEach((v) => chk('on-dark/' + v, a.onDark, k[v], 4.5));
  chk('on-dark/floor panel', a.onDark, '#0a1018', 4.5);
  return out;
}

console.log('\n1. the list');
{
  ok('there are skins to test against (ten)', Object.keys(skins).length === 10, Object.keys(skins).join(','));
  ok('a small curated set, 6 to 10 accents', A.ACCENTS.length >= 6 && A.ACCENTS.length <= 10, String(A.ACCENTS.length));
  ok('every id is unique and every colour is a 6-digit hex', new Set(A.ACCENTS.map((a) => a.id)).size === A.ACCENTS.length && A.ACCENTS.every((a) => ['fill', 'onLight', 'onDark'].every((f) => /^#[0-9a-f]{6}$/i.test(a[f]))));
  const BANNED = /pantone|coca|starbucks|tiffany|facebook|twitter|ups|fedex|home ?depot|lowe|gaf|tamko|iko|nbd|batman|mario|pok[eé]mon/i;
  ok('no trademarked colour names', A.ACCENTS.every((a) => !BANNED.test(a.label) && !BANNED.test(a.id)), A.ACCENTS.map((a) => a.label).join(', '));
  ok('control: the name checker catches one', BANNED.test('Tiffany Blue'));
}

console.log('\n2. the whole accent x skin matrix (real WCAG ratios)');
{
  let pairs = 0, bad = [];
  A.ACCENTS.forEach((a) => Object.keys(skins).forEach((id) => {
    pairs++;
    const f = failures(a, skins[id]);
    if (f.length) bad.push(a.id + ' on ' + id + ': ' + f.join('; '));
  }));
  ok('all ' + pairs + ' pairs pass (accent x skin)', pairs === A.ACCENTS.length * 10 && !bad.length, bad.join(' | '));
  // negative controls: the matrix must be able to fail, for each kind of pair
  const light = skins.light, dark = skins.default;
  ok('control: a pale fill fails the white-text check', failures({ id: 'x', fill: '#F5C242', onLight: '#7A4B00', onDark: '#FFC857' }, dark).some((s) => /^white\/fill/.test(s)));
  ok('control: a dark text tint fails on a dark card', failures({ id: 'x', fill: '#B4461E', onLight: '#9A3A14', onDark: '#3a1000' }, dark).some((s) => /^text\/card/.test(s)));
  ok('control: a light text tint fails on a light card', failures({ id: 'x', fill: '#B4461E', onLight: '#FFB27A', onDark: '#FF9A70' }, light).some((s) => /^text\/card/.test(s)));
  ok('control: a dim on-dark tint fails on the header bar', failures({ id: 'x', fill: '#B4461E', onLight: '#9A3A14', onDark: '#553322' }, dark).some((s) => /^on-dark/.test(s)));
  const without = (k, v) => { const o = Object.assign({}, k); delete o[v]; return o; };
  ['--paper', '--bg', '--bar', '--tabbar', '--taboff'].forEach((v) => {
    ok('control: a skin missing ' + v + ' FAILS the matrix (never a silent pass)', failures(A.ACCENTS[0], without(dark, v)).some((m) => m.indexOf(v) > -1));
  });
  ok('control: an unparseable skin token (rgba) fails', failures(A.ACCENTS[0], Object.assign({}, dark, { '--paper': 'rgba(255,255,255,.1)' })).some((m) => /--paper/.test(m)));
  ok('control: an accent with a malformed colour fails', failures({ id: 'x', fill: 'teal', onLight: '#0B5F58', onDark: '#5FD6C8' }, dark).some((m) => /fill/.test(m)));
  ok('every one of the ten real skins carries all five tokens the matrix reads', Object.keys(skins).every((id) => ['--paper', '--bg', '--bar', '--tabbar', '--taboff'].every((v) => A.isHex(skins[id][v]))), Object.keys(skins).join(','));
  ok('control: a good accent passes on both a light and a dark skin', !failures(A.ACCENTS[0], light).length && !failures(A.ACCENTS[0], dark).length);
}

console.log('\n3. logic');
{
  const a = A.ACCENTS[0];
  ok('a light card gets the light-surface tint, a dark card the dark-surface tint', A.textFor(a, '#ffffff') === a.onLight && A.textFor(a, '#12161c') === a.onDark);
  ok('a missing or rgba card value takes the dark-surface tint (the safe side)', A.textFor(a, '') === a.onDark && A.textFor(a, 'rgba(255,255,255,.1)') === a.onDark);
  ok('vars() sets --ac to the fill, --ac-text to the surface tint and --ac-on-dark', JSON.stringify(A.vars(a.id, '#ffffff')) === JSON.stringify({ '--ac': a.fill, '--ac-text': a.onLight, '--ac-on-dark': a.onDark, '--orange': a.onDark }));
  ok('a custom theme (no --paper rule) is judged by its own background, not assumed dark', A.surfaceOf('', '#ffffff') === '#ffffff' && A.textFor(a, A.surfaceOf('', '#ffffff')) === a.onLight && A.textFor(a, A.surfaceOf('', '#101820')) === a.onDark);
  ok('a real --paper wins over the theme background; neither usable means dark', A.surfaceOf(' #12161c', '#ffffff') === '#12161c' && A.surfaceOf('', '') === '' && A.surfaceOf(undefined, 'red') === '');
  ok('an unknown id or hand-edited storage means "theme default"', A.normAccent('nope') === null && A.normAccent(null) === null && A.normAccent(42) === null && A.vars('nope', '#fff') === null);
  ok('a real id round-trips', A.normAccent('teal') === 'teal');
}

console.log('\n4. wiring');
{
  ok('both scripts load deferred, logic before ui', /accent-logic\.js[^>]*defer/.test(HTML) && /accent-ui\.js[^>]*defer/.test(HTML) && HTML.indexOf('accent-logic.js') < HTML.indexOf('accent-ui.js'));
  ok('the swatch row mounts in the Themes tab', /id="npm-accents"/.test(HTML));
  ok('no inline handlers were added for it', !/<[^>]*acc-(sw|reset)[^>]*\son[a-z]+=/.test(HTML));
  ok('persisted per device, guarded by try/catch', /try\s*\{\s*return localStorage\.getItem\(A\.KEY\)/.test(UI) && /try\s*\{\s*if \(next\) localStorage\.setItem\(A\.KEY, next\)/.test(UI));
  ok('"Theme default" resets (empty pick id removes the key) and restores the theme\'s own --ac', /data-accent-pick=""/.test(UI) && /localStorage\.removeItem\(A\.KEY\)/.test(UI) && /themeAccent\(\)/.test(UI));
  ok('re-applies after every theme change (MutationObserver on data-theme)', /MutationObserver\(apply\)\.observe\(html, \{ attributes: true, attributeFilter: \['data-theme'\] \}\)/.test(UI));
  ok('accent code never assigns document.body.className', !/body\.className\s*=/.test(UI));
  ok('swatch and reset targets are 44px', /:root \.acc-sw\{width:44px;height:44px;/.test(HTML) && /:root \.acc-reset\{min-height:44px;/.test(HTML));
  const lastStyle = HTML.slice(HTML.lastIndexOf('<style'));
  ok('the picker CSS sits in the LAST <style> block, at :root specificity', /:root \.acc-row\{/.test(lastStyle) && /:root \.acc-sw\{/.test(lastStyle));
  ok('control: app.js is untouched by this feature (no accent code there)', !/NBDAccent|nbd_ds_accent/.test(APP));
  // behaviour: drive the real ui file against a stub DOM
  const UI_SRC = fs.readFileSync(path.join(DIR, 'js', 'accent-ui.js'), 'utf8');
  function boot(o) {
    o = o || {};
    const c = { store: Object.assign({}, o.store), style: {}, paper: 'paper' in o ? o.paper : '#ffffff', theme: o.theme || { accent: '#BD5728', bg: '#0A0C0F' }, listeners: {}, observers: [], mount: { innerHTML: '' } };
    const html = { style: { setProperty: (k, v) => { c.style[k] = v; }, removeProperty: (k) => { delete c.style[k]; } } };
    c.ctx = { window: { NBDAccent: A }, document: { documentElement: html, getElementById: (id) => (id === 'npm-accents' ? c.mount : null), addEventListener: (t, fn) => { c.listeners[t] = fn; } },
      localStorage: { getItem: (k) => { if (o.throwRead) throw new Error('blocked'); return k in c.store ? c.store[k] : null; }, setItem: (k, v) => { if (o.throwWrite) throw new Error('blocked'); c.store[k] = v; }, removeItem: (k) => { if (o.throwWrite) throw new Error('blocked'); delete c.store[k]; } },
      getComputedStyle: () => ({ getPropertyValue: () => c.paper }),
      MutationObserver: function (fn) { this.observe = (el, opts) => { c.observers.push({ fn, opts }); }; },
      _nbdGetTheme: () => c.theme, _nbd_activeTheme: 'default' };
    c.ctx.window.window = c.ctx.window;
    vm.runInNewContext(UI_SRC, c.ctx);
    c.api = c.ctx.window.NBDAccent;
    c.click = (attr) => { // a click whose nearest [data-accent-pick] ancestor carries attr (null = a click elsewhere)
      const el = attr === null ? null : { getAttribute: () => attr };
      c.listeners.click({ target: { closest: (sel) => (sel === '[data-accent-pick]' ? el : null) } });
    };
    return c;
  }
  let c = boot();
  const store = c.store, style = c.style, api = c.api;
  api.set('teal');
  ok('picking an accent stores it and sets the properties (light card -> light tint)', store.nbd_ds_accent === 'teal' && style['--ac'] === '#0F766E' && style['--ac-text'] === '#0B5F58' && style['--ac-on-dark'] === '#5FD6C8' && style['--orange'] === '#5FD6C8');
  api.set('not-an-accent');
  ok('control: an unknown id behaves as reset, never as a colour', !('nbd_ds_accent' in store) && style['--ac'] === '#BD5728' && !('--ac-text' in style));
  api.set('rose'); api.set('');
  ok('Reset to theme default clears storage and the text overrides, puts the theme accent (and --orange) back', !('nbd_ds_accent' in store) && style['--ac'] === '#BD5728' && style['--orange'] === '#BD5728' && !('--ac-text' in style) && !('--ac-on-dark' in style));
  ok('the swatch row renders every accent plus a reset, none checked when on theme default', (c.mount.innerHTML.match(/data-accent-pick="[a-z]+"/g) || []).length === A.ACCENTS.length && /data-accent-pick=""/.test(c.mount.innerHTML) && (c.mount.innerHTML.match(/aria-checked="true"/g) || []).length === 0);

  // the click handler (delegated on document)
  c = boot();
  ok('a click handler is registered on the document', typeof c.listeners.click === 'function');
  c.click('plum');
  ok('clicking a swatch picks that accent', c.store.nbd_ds_accent === 'plum' && c.style['--ac'] === '#9D2D7E' && /aria-checked="true"[^>]*data-accent-pick="plum"/.test(c.mount.innerHTML));
  c.click(null);
  ok('control: a click that is not on a swatch changes nothing', c.store.nbd_ds_accent === 'plum' && c.style['--ac'] === '#9D2D7E');
  c.click('');
  ok('clicking "Theme default" resets', !('nbd_ds_accent' in c.store) && c.style['--ac'] === '#BD5728');
  c.click('javascript:alert(1)');
  ok('control: a forged pick value is not an accent', !('nbd_ds_accent' in c.store) && c.style['--ac'] === '#BD5728');

  // the observer: a theme change re-applies the accent with the NEW skin's tint
  c = boot({ store: { nbd_ds_accent: 'indigo' }, paper: '#12161c' });
  ok('a saved accent is applied at load (dark card -> dark tint)', c.style['--ac'] === '#4F46E5' && c.style['--ac-text'] === '#B4B0FF');
  ok('the observer watches data-theme on the root', c.observers.length === 1 && JSON.stringify(c.observers[0].opts) === JSON.stringify({ attributes: true, attributeFilter: ['data-theme'] }));
  c.paper = '#ffffff'; c.style['--ac'] = '#BD5728'; // app.js's nbdApplyTheme has just written the new theme's --ac inline
  c.observers[0].fn();
  ok('after a theme change the accent goes back on top, with the new skin\'s tint (light card -> light tint)', c.style['--ac'] === '#4F46E5' && c.style['--ac-text'] === '#4338CA');
  c = boot({ paper: '#12161c' });
  c.theme = { accent: '#2A7F46', bg: '#040e06' }; c.observers[0].fn();
  ok('with no accent chosen, a theme change leaves the new theme\'s own accent', c.style['--ac'] === '#2A7F46' && !('--ac-text' in c.style));

  // storage that throws
  c = boot({ throwRead: true });
  ok('a throwing stored() does not break the page and means "theme default"', c.api.current() === null && c.style['--ac'] === '#BD5728' && typeof c.listeners.click === 'function');
  c = boot({ throwWrite: true });
  let threw = false; try { c.api.set('plum'); } catch (_) { threw = true; }
  ok('blocked storage does not throw and still applies for this visit', !threw && c.style['--ac'] === '#9D2D7E' && c.api.current() === 'plum');

  // a saved custom theme has no --paper rule: judged by its own background
  c = boot({ store: { nbd_ds_accent: 'teal' }, paper: '', theme: { accent: '#ff0000', bg: '#101820' } });
  ok('custom dark theme (no --paper) gets the dark-surface text tint', c.style['--ac-text'] === '#5FD6C8');
  c = boot({ store: { nbd_ds_accent: 'teal' }, paper: '', theme: { accent: '#ff0000', bg: '#f4f4f0' } });
  ok('custom light theme (no --paper) gets the light-surface text tint', c.style['--ac-text'] === '#0B5F58');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
