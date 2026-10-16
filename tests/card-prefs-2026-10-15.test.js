#!/usr/bin/env node
/**
 * tests/card-prefs-2026-10-15.test.js — "Customize this screen": hide and
 * reorder each layout's cards, saved on this device.
 *
 *   A. the pure rules: clean prefs, move, toggle, never everything hidden
 *   B. applying prefs to a real-ish DOM: permute in place, hide, nothing else moves
 *   C. the sheet: 44px Up/Down, Show switches, Reset, the last card cannot be hidden, company lock
 *   D. storage: per device, per user, try/catch, kept across sign-out
 *   E. wiring: an entry in every layout's Menu and on Home, the lazy bundle, CSP-clean
 *
 * Run: node tests/card-prefs-2026-10-15.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const P = require(path.join(ROOT, 'docs/pro/js/card-prefs.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 500) : '')); failed++; }
}

// ── a tiny DOM: enough for querySelector by one selector, insertBefore, attributes ─
function makeDom() {
  let seq = 0;
  function node(tag, attrs) {
    const n = { tag, attrs: Object.assign({}, attrs || {}), children: [], parentNode: null, _id: ++seq, nodeType: tag === '#comment' ? 8 : 1 };
    n.getAttribute = (k) => (k in n.attrs ? n.attrs[k] : null);
    n.setAttribute = (k, v) => { n.attrs[k] = String(v); };
    n.removeAttribute = (k) => { delete n.attrs[k]; };
    n.hasAttribute = (k) => k in n.attrs;
    n.appendChild = (c) => { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = n; n.children.push(c); return c; };
    n.removeChild = (c) => { const i = n.children.indexOf(c); if (i !== -1) n.children.splice(i, 1); c.parentNode = null; return c; };
    n.insertBefore = (c, ref) => { if (c.parentNode) c.parentNode.removeChild(c); const i = ref ? n.children.indexOf(ref) : -1; c.parentNode = n; if (i === -1) n.children.push(c); else n.children.splice(i, 0, c); return c; };
    n.contains = (x) => { for (let p = x; p; p = p.parentNode) if (p === n) return true; return false; };
    n.compareDocumentPosition = (o) => (order(n) < order(o) ? 4 : 2);
    return n;
  }
  const body = node('body');
  function walk(n, out) { out.push(n); n.children.forEach((c) => walk(c, out)); return out; }
  function order(n) { return walk(body, []).indexOf(n); }
  function matches(n, sel) {
    sel = sel.trim();
    const parts = sel.split(/\s+/);
    const last = parts[parts.length - 1];
    const one = (x, s) => {
      if (!x || x.nodeType !== 1) return false;
      if (s[0] === '#') return x.attrs.id === s.slice(1);
      if (s[0] === '.') return String(x.attrs.class || '').split(/\s+/).indexOf(s.slice(1)) !== -1;
      const m = s.match(/^\[([a-z-]+)(?:="([^"]*)")?\]$/);
      if (m) return m[2] == null ? m[1] in x.attrs : x.attrs[m[1]] === m[2];
      return x.tag === s;
    };
    if (!one(n, last)) return false;
    if (parts.length === 1) return true;
    for (let p = n.parentNode; p; p = p.parentNode) if (one(p, parts[parts.length - 2])) return true;
    return false;
  }
  const doc = {
    body, documentElement: node('html', { 'data-layout': 'field' }), activeElement: null,
    createComment: () => node('#comment'),
    createElement: (t) => { const n = node(t); Object.defineProperty(n, 'innerHTML', { set(v) { n._html = v; }, get() { return n._html || ''; } }); n.querySelector = () => null; n.querySelectorAll = () => []; return n; },
    querySelector: (sel) => { const all = walk(body, []); for (const s of sel.split(',')) { const hit = all.find((x) => matches(x, s)); if (hit) return hit; } return null; },
    contains: (x) => body.contains(x),
  };
  return { doc, node, body, order: () => body.children.map((c) => c.attrs['data-k'] || c.attrs.id || c.tag) };
}

function sandbox(o) {
  const opt = o || {};
  const dom = makeDom();
  const store = opt.store || {};
  const listeners = {};
  dom.doc.addEventListener = (n, f) => { (listeners[n] = listeners[n] || []).push(f); };
  const win = {
    document: dom.doc,
    _user: { uid: opt.uid || 'u1' },
    LayoutEngine: { current: () => ({ id: opt.layout || 'field', source: 'user', surface: 'phone' }), prefs: () => ({ company: { locked: !!opt.locked } }) },
    addEventListener: () => {},
    requestAnimationFrame: (f) => f(),
  };
  const ls = opt.brokenStorage
    ? { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } }
    : { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  const ctx = { window: win, document: dom.doc, localStorage: ls, console, JSON, Object, Array, String, setTimeout: (f) => f(), MutationObserver: undefined };
  vm.createContext(ctx);
  vm.runInContext(read('docs/pro/js/card-prefs.js'), ctx);
  return { win, dom, store, listeners, CP: win.NBDCardPrefs };
}
// Field's Today, the way field.js paints it: header and progress line are not cards.
function fieldToday(dom) {
  const scroll = dom.node('div', { class: 'fa-scroll', 'data-k': 'scroll' });
  dom.body.appendChild(scroll);
  [['div', { class: 'fa-top', 'data-k': 'top' }], ['div', { 'data-ns-slot': 'field', 'data-k': 'nextstop' }], ['div', { class: 'fa-prog', 'data-k': 'prog' }],
    ['section', { class: 'fa-now', 'data-k': 'now' }], ['div', { 'data-fa-group': 'upnext', 'data-k': 'upnext' }],
    ['div', { 'data-cash-slot': 'field', 'data-k': 'cash' }], ['div', { 'data-cwk-slot': 'field', 'data-k': 'closesweek' }]].forEach((x) => scroll.appendChild(dom.node(x[0], x[1])));
  const root = dom.node('div', { id: 'nbdFieldRoot' });
  dom.body.insertBefore(root, scroll); root.appendChild(scroll);
  return () => scroll.children.map((c) => c.attrs['data-k'] + (('data-hc-off' in c.attrs) ? '(off)' : ''));
}

console.log('\nA. the pure rules');
{
  const ids = P.idsOf('field');
  const d = P.sanitize(null, ids);
  ok('no prefs = the default order, nothing hidden', d.order.join() === ids.join() && d.off.length === 0 && P.isDefault(d, ids));
  const junk = P.sanitize({ order: ['cash', 'cash', 'bogus', 'now'], off: ['bogus', 'done', 'done'] }, ids);
  ok('unknown and duplicate ids are dropped; every card is present once', junk.order.length === ids.length && new Set(junk.order).size === ids.length && junk.off.join() === 'done', JSON.stringify(junk));
  ok('saved order is kept for known cards', junk.order.indexOf('cash') < junk.order.indexOf('now'));
  const allOff = P.sanitize({ order: ids, off: ids }, ids);
  ok('a saved "everything hidden" comes back with the first card on', allOff.off.length === ids.length - 1 && allOff.off.indexOf(ids[0]) === -1);
  let p = d;
  ids.forEach((id) => { p = P.toggle(p, id, false); });
  ok('hiding one card after another stops at the last visible one', p.order.length - p.off.length === 1, JSON.stringify(p));
  ok('moving the first card up, or the last down, is a no-op', P.move(d, ids[0], -1) === d && P.move(d, ids[ids.length - 1], 1) === d);
  const m = P.move(d, 'cash', -1);
  ok('Move up swaps with the card above', m.order.indexOf('cash') === ids.indexOf('cash') - 1);
  ok('every layout has cards, and none of them repeats an id', ['classic', 'bento', 'island', 'field', 'focus', 'crew', 'inbox', 'mission'].every((l) => P.idsOf(l).length >= 3 && new Set(P.idsOf(l)).size === P.idsOf(l).length));
  ok('Bento leaves out "Widgets and more" (its board is the widgets)', P.idsOf('bento').indexOf('more') === -1 && P.idsOf('classic').indexOf('more') !== -1);
}

console.log('\nB. applying prefs to the screen');
{
  const sb = sandbox({ store: { nbd_card_prefs: JSON.stringify({ u1: { field: { order: ['closesweek', 'cash', 'nextstop', 'now', 'upnext', 'done'], off: ['upnext'] } } }) } });
  const seen = fieldToday(sb.dom);
  sb.CP.apply();
  const after = seen();
  ok('the cards take the saved order among their own places', after.join() === 'top,closesweek,prog,cash,nextstop,now,upnext(off)', after.join());
  ok('what is not a card (the header, the progress line) never moves', after[0] === 'top' && after[2] === 'prog', after.join());
  ok('a hidden card is marked [data-hc-off], not removed', after.indexOf('upnext(off)') !== -1);
  const twice = seen().join();
  sb.CP.apply();
  ok('applying again changes nothing (no repaint loop)', seen().join() === twice);
  const other = sandbox({ uid: 'u2', store: sb.store });
  const seen2 = fieldToday(other.dom);
  other.CP.apply();
  ok('another user on this phone gets the default order', seen2().join() === 'top,nextstop,prog,now,upnext,cash,closesweek', seen2().join());
  const lock = sandbox({ locked: true, store: sb.store });
  const seen3 = fieldToday(lock.dom);
  lock.CP.apply();
  ok('company layout lock: the screen stays in the default order', seen3().join() === 'top,nextstop,prog,now,upnext,cash,closesweek', seen3().join());
}

{
  // Default prefs never move a card, even where the list order differs from
  // the layout's own (Crew puts Cash UNDER the schedule, Next stop above it).
  const sb = sandbox({ layout: 'crew' });
  const wrap = sb.dom.node('div', { class: 'cw-wrap', 'data-k': 'wrap' });
  sb.dom.body.appendChild(wrap);
  [['div', { class: 'cw-top', 'data-k': 'top' }], ['div', { 'data-ns-slot': 'crew', 'data-k': 'nextstop' }], ['div', { 'data-cash-slot': 'crew', 'data-k': 'cash' }],
    ['div', { 'data-cwk-slot': 'crew', 'data-k': 'closesweek' }], ['div', { class: 'cw-grid', 'data-k': 'grid' }]].forEach((x) => wrap.appendChild(sb.dom.node(x[0], x[1])));
  const before = wrap.children.map((c) => c.attrs['data-k']).join();
  sb.CP.apply();
  ok('no saved prefs: every card stays where the layout put it (Crew\'s Cash stays under the grid)', wrap.children.map((c) => c.attrs['data-k']).join() === before, wrap.children.map((c) => c.attrs['data-k']).join());
  ok('the Crew list matches its layout\'s own order', P.idsOf('crew').join() === 'nextstop,closesweek,cash');
}

console.log('\nC. the sheet');
{
  const sb = sandbox({});
  fieldToday(sb.dom);
  const p0 = sb.CP._load('field');
  ok('the screen in use is read from LayoutEngine.current().id', sb.CP.current() === 'field');
  sb.CP.open();
  const scrim = sb.dom.body.children[sb.dom.body.children.length - 1];
  const h = scrim.innerHTML;
  ok('a labelled modal dialog', /role="dialog" aria-modal="true" aria-labelledby="hcTitle"/.test(h) && /Customize Field App/.test(h));
  ok('every card has a Show switch and Move up / Move down with names', P.idsOf('field').every((id) => new RegExp('data-hc="show" data-hc-id="' + id + '"').test(h) && new RegExp('data-hc="up" data-hc-id="' + id + '"').test(h) && new RegExp('data-hc="down" data-hc-id="' + id + '"').test(h)) && /aria-label="Move Cash collected up"/.test(h));
  ok('Reset to default (disabled while already default) and Done', /data-hc="reset" disabled>Reset to default/.test(h) && /data-hc="close">Done/.test(h));
  const fire = (name, attrs, extra) => {
    const t = Object.assign({ getAttribute: (k) => (k in attrs ? attrs[k] : null), hasAttribute: (k) => k in attrs }, extra || {});
    t.closest = () => t;
    const owner = { contains: () => true };
    sb.CP.close; // keep lint quiet
    (sb.listeners[name] || []).forEach((f) => f({ target: t, preventDefault() {}, key: attrs.key }));
    return owner;
  };
  // the sheet's contains() must see the clicked button: give the scrim one
  scrim.contains = () => true;
  const first = p0.order[0];
  fire('click', { 'data-hc': 'down', 'data-hc-id': first });
  const p1 = sb.CP._load('field');
  ok('Move down saves the new order on this device', p1.order[1] === first && p1.order[0] === p0.order[1] && /"field"/.test(sb.store.nbd_card_prefs || ''), JSON.stringify(p1));
  fire('change', { 'data-hc': 'show', 'data-hc-id': 'cash' }, { checked: false });
  ok('switching a card off saves it hidden', sb.CP._load('field').off.indexOf('cash') !== -1);
  P.idsOf('field').forEach((id) => fire('change', { 'data-hc': 'show', 'data-hc-id': id }, { checked: false }));
  const pAll = sb.CP._load('field');
  ok('trying to switch everything off leaves one card on', pAll.order.length - pAll.off.length === 1, JSON.stringify(pAll));
  ok('…and its switch is disabled with the reason', /disabled aria-describedby="hcLast"/.test(scrim.innerHTML) && /One card always stays on/.test(scrim.innerHTML));
  fire('click', { 'data-hc': 'reset' });
  ok('Reset to default forgets this layout\'s prefs', P.isDefault(sb.CP._load('field'), P.idsOf('field')) && !/"field"/.test(sb.store.nbd_card_prefs || ''));
  const lk = sandbox({ locked: true });
  lk.CP.open('field');
  const lh = lk.dom.body.children[lk.dom.body.children.length - 1].innerHTML;
  ok('company lock: the sheet explains and offers no controls', /locked the layout/.test(lh) && !/data-hc="show"/.test(lh) && !/data-hc="up"/.test(lh));
}

console.log('\nD. storage');
{
  const broken = sandbox({ brokenStorage: true });
  let threw = false;
  try { fieldToday(broken.dom); broken.CP.apply(); broken.CP._save('field', P.move(P.sanitize(null, P.idsOf('field')), 'cash', -1)); } catch (e) { threw = e; }
  ok('blocked storage never throws (defaults are kept)', threw === false, threw);
  ok('_save reports a blocked write', broken.CP._save('field', P.move(P.sanitize(null, P.idsOf('field')), 'cash', -1)) === false);
  const src = read('docs/pro/js/card-prefs.js');
  ok('every localStorage access is inside try/catch', (src.match(/localStorage\./g) || []).length === (src.match(/try \{[^}]*localStorage\./g) || []).length + (src.match(/try \{\s*\n\s*var all = readAll\(\)[\s\S]*?localStorage\.setItem/g) || []).length, (src.match(/localStorage\./g) || []).length);
  ok('kept across sign-out like the other layout preferences', /'nbd_card_prefs'/.test(read('docs/pro/js/nbd-auth.js')));
  const many = sandbox({});
  for (let i = 0; i < 12; i++) { many.win._user.uid = 'u' + i; many.CP._save('field', P.move(P.sanitize(null, P.idsOf('field')), 'cash', -1)); }
  ok('a shared phone stays bounded (8 users at most)', Object.keys(JSON.parse(many.store.nbd_card_prefs)).length === 8);
}

console.log('\nE. wiring');
{
  const K = require(path.join(ROOT, 'docs/pro/js/layouts/kit.js'));
  const menu = K.menuItems('fa');
  ok('every layout\'s Menu ends with "Customize this screen"', /<button type="button" role="menuitem" data-hc-open="">Customize this screen<\/button>$/.test(menu));
  ok('…and the Menu still has its five places', (menu.match(/data-fa="goto"/g) || []).length === 5);
  const dash = read('docs/pro/dashboard.html');
  ok('Home has "Arrange Home" in the header and under More on Home', (dash.match(/data-hc-open="">↕️ Arrange Home/g) || []).length === 2);
  ok('Bento (which hides More on Home) keeps the header entry on a phone', /html\[data-layout="bento"\] \.home-hdr-acts > \.hc-home-open\{display:inline-flex;\}/.test(read('docs/pro/css/card-prefs.css')));
  const sl = read('docs/pro/js/script-loader.js');
  ok('lazy bundle "cardprefs" (?v=), kicked by today-home.js', /cardprefs: \[\s*'css\/card-prefs\.css\?v=\d+',\s*'js\/card-prefs\.js\?v=\d+'\s*\]/.test(sl) && /loadBundle\('cardprefs'\)/.test(read('docs/pro/js/today-home.js')));
  const field = read('docs/pro/js/layouts/field.js'), focus = read('docs/pro/js/layouts/focus.js');
  ok('Field wraps Up next and Done so each moves as one card', /data-fa-group="upnext"/.test(field) && /data-fa-group="done"/.test(field));
  ok('Focus wraps its queue so it moves as one card', /<div class="fo-queue">/.test(focus));
  const css = read('docs/pro/css/card-prefs.css'), js = read('docs/pro/js/card-prefs.js');
  ok('Up / Down / Done / Reset are 44px; the Show row is 44px', /\.hc-btn\{[^}]*min-height:44px;min-width:44px/.test(css) && /\.hc-show\{[^}]*min-height:44px/.test(css));
  ok('a hidden card is display:none, whatever the layout says', /\[data-hc-off\]\{display:none !important;\}/.test(css));
  ok('CSP: no inline handlers or style attributes', !/\son[a-z]+=/i.test(js) && !/style=/.test(js) && !/\.style\./.test(js));
  ok('Escape closes the sheet and Tab stays inside it', /ev\.key === 'Escape'/.test(js) && /ev\.key !== 'Tab'/.test(js));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
