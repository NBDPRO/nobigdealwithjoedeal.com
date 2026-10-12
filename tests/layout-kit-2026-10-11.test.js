/**
 * tests/layout-kit-2026-10-11.test.js — D1: the shared layout components
 * (js/layouts/kit.js + css/layouts/kit.css) and the registry's `needs`.
 *
 *   1. escaping: every dynamic value (name, address, why, badge, ids, labels)
 *      is HTML-escaped in every component — lead fields are PUBLIC input
 *   2. ActionBar: tel/sms digits-only, maps URL encoded, a link with nothing
 *      to link to renders DISABLED not as a dead anchor, buttons carry ids
 *   3. LeadCard densities, Widget states + size contract, bottom Nav
 *   4. bind(): one delegated listener, handler > LeadSnooze > event fallback,
 *      nothing outside the container, unbind works
 *   5. registry `needs` accepts only js/layouts|css/layouts paths; kit.css is
 *      tokens-only and lk-prefixed so it cannot touch Classic
 *
 * Run: node tests/layout-kit-2026-10-11.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const K = require(path.join(ROOT, 'docs/pro/js/layouts/kit.js'));
const R = require(path.join(ROOT, 'docs/pro/js/layout-system.js'));
const EVIL = '<img src=x onerror=alert(1)>"\'&';
const item = K.fromLead({ id: 'L1', firstName: EVIL, lastName: '', address: EVIL + ', Cincinnati OH', phone: '(513) 555-0142', stage: 'Estimate' },
  { why: EVIL, timeLabel: EVIL, badge: EVIL });

console.log('\n1. escaping');
{
  const html = [
    K.card(item, { density: 'row' }), K.card(item, { density: 'card', actions: ['call', 'text', 'navigate', 'snooze'] }),
    K.card(item, { density: 'hero', actions: ['call', 'photo'] }),
    K.actionBar(item, ['call', 'snooze'], { labels: { call: EVIL } }),
    K.widget({ id: EVIL, title: EVIL, aside: EVIL, state: 'empty', emptyText: EVIL }),
    K.widget({ title: 'x', state: 'loading', loadingText: EVIL }),
    K.nav('bottom', [{ id: EVIL, label: EVIL, icon: 'today' }], 'nope'),
  ].join('\n');
  ok('no raw <img / unescaped quote-breakout survives in any component', !/<img/i.test(html) && !/onerror=alert\(1\)>/.test(html) && html.includes('&lt;img'));
  ok('the evil string never appears unescaped inside an attribute value',
    !/="[^"]*<img[^"]*"/.test(html) && !/="[^"]*"onerror/.test(html));
  ok('esc handles null/undefined/numbers', K.esc(null) === '' && K.esc(undefined) === '' && K.esc(5) === '5');
}

console.log('\n2. ActionBar');
{
  const good = K.fromLead({ id: 'L2', firstName: 'Pat', lastName: 'Nguyen', address: '12 Main St, Florence KY', phone: '513-555-0142' });
  const bar = K.actionBar(good, ['call', 'text', 'navigate', 'open', 'snooze', 'photo', 'done'], { primary: 'call' });
  ok('call is a tel: link with +1 and 10 digits', /href="tel:\+15135550142"/.test(bar));
  ok('text is an sms: link (the OS composer; the rep presses Send there)', /href="sms:\+15135550142"/.test(bar));
  ok('navigate is a maps URL with the address encoded, opened with noopener',
    /href="https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=12%20Main%20St%2C%20Florence%20KY"[^>]*target="_blank" rel="noopener"/.test(bar));
  ok('open goes to the customer page for that id', /href="\/pro\/customer\.html\?id=L2"/.test(bar));
  ok('button actions carry data-lk-act and the lead id',
    /data-lk-act="snooze" data-lead-id="L2"/.test(bar) && /data-lk-act="photo" data-lead-id="L2"/.test(bar) && /data-lk-act="done" data-lead-id="L2"/.test(bar));
  ok('primary is flagged', /lk-act-call lk-act-primary/.test(bar));
  const nope = K.fromLead({ id: 'L3', firstName: 'No', lastName: 'Phone' });
  const bar2 = K.actionBar(nope, ['call', 'text', 'navigate'], {});
  ok('no phone / no address -> disabled buttons, never an href-less anchor',
    (bar2.match(/lk-act-off/g) || []).length === 3 && !/<a class="lk-act/.test(bar2) && /disabled aria-disabled="true"/.test(bar2));
  ok('a junk phone is not turned into a tel: link', K.telUrl('555-0142') === '' && K.telUrl('abc') === '' && K.smsUrl('') === '');
  ok('11-digit with leading 1 normalises', K.telUrl('1 (513) 555-0142') === 'tel:+15135550142');
  ok('unknown action ids are skipped, not thrown', K.actionBar(good, ['bogus', 'call'], {}).split('lk-act ').length === 2);
  ok('every ACTIONS entry has label/icon/kind and an icon path exists',
    Object.keys(K.ACTIONS).every((k) => K.ACTIONS[k].label && K.ACTIONS[k].kind && K.icon(K.ACTIONS[k].icon).indexOf('<path') !== -1));
}

console.log('\n3. card / widget / nav');
{
  const it = K.fromLead({ id: 'L4', firstName: 'Ana', lastName: 'Ruiz', address: '9 Oak Ln', phone: '5135550199' }, { why: 'Opened your estimate 3 times today', timeLabel: '9:30 AM' });
  const row = K.card(it, { density: 'row' });
  const cardH = K.card(it, { density: 'card', actions: ['call'] });
  const hero = K.card(it, { density: 'hero', actions: ['call', 'text'], primary: 'call' });
  ok('row: time + name + address + open link, no why, no action bar',
    /lk-card-row/.test(row) && /9:30 AM/.test(row) && /Ana Ruiz/.test(row) && !/lk-why/.test(row) && !/lk-actions/.test(row) && /data-lk-link="open"/.test(row));
  ok('card: shows the why line and a compact action bar', /lk-card-card/.test(cardH) && /lk-why/.test(cardH) && /lk-actions-sm/.test(cardH));
  ok('hero: formatted phone + a large action bar', /lk-card-hero/.test(hero) && /\(513\) 555-0199/.test(hero) && /lk-actions-lg/.test(hero));
  ok('unknown density falls back to card', /lk-card-card/.test(K.card(it, { density: 'weird' })));
  ok('current/done flags', /lk-card-current/.test(K.card(it, { current: true })) && /lk-card-done/.test(K.card(it, { done: true })));
  ok('leadName falls back firstName+lastName > name > address street > Customer',
    K.leadName({ firstName: 'A', lastName: 'B' }) === 'A B' && K.leadName({ name: 'Co' }) === 'Co'
    && K.leadName({ address: '1 Elm St, X' }) === '1 Elm St' && K.leadName({}) === 'Customer');

  ok('widget: size contract, unknown size -> 1x1', /lk-w-2x2/.test(K.widget({ size: '2x2', body: 'x' })) && /lk-w-1x1/.test(K.widget({ size: '9x9' })));
  ok('widget: loading and empty states replace the body',
    /lk-w-loading[\s\S]*Loading/.test(K.widget({ state: 'loading', body: 'SECRET' })) && !/SECRET/.test(K.widget({ state: 'empty', body: 'SECRET' })));
  ok('widget ok state passes the (already escaped) body through', /<b>hi<\/b>/.test(K.widget({ body: '<b>hi</b>' })));
  const n = K.nav('bottom', [{ id: 'today', label: 'Today', icon: 'today' }, { id: 'cam', label: 'Capture', icon: 'photo', raised: true }, { id: 'me', label: 'Me', icon: 'me' }], 'today');
  ok('bottom nav: active item aria-current, raised centre button', /lk-nav-active[^>]*data-lk-nav="today"|data-lk-nav="today"[^>]*aria-current="page"/.test(n) && /lk-nav-raised[^>]*data-lk-nav="cam"/.test(n));
  ok('every nav item is a real <button> with an aria-label', (n.match(/<button type="button"/g) || []).length === 3 && (n.match(/aria-label=/g) || []).length >= 3);
}

console.log('\n4. bind()');
{
  // minimal DOM: a root with one listener; elements answer closest()/getAttribute()
  function el(attrs, parent) {
    const e = { _a: attrs || {}, parent, getAttribute(k) { return k in this._a ? this._a[k] : null; },
      closest(sel) {
        const m = /^\[([a-z-]+)\]$/.exec(sel); let cur = this;
        while (cur) { if (m && cur._a && m[1] in cur._a) return cur; cur = cur.parent; }
        return null;
      } };
    return e;
  }
  const events = [];
  const rootEl = { _l: [], addEventListener(t, f) { this._l.push(f); }, removeEventListener(t, f) { this._l = this._l.filter((x) => x !== f); },
    contains(x) { let c = x; while (c) { if (c === rootEl) return true; c = c.parent; } return false; },
    dispatchEvent(ev) { events.push(ev); return true; }, click(target) { let prevented = false;
      this._l.forEach((f) => f({ target, preventDefault() { prevented = true; } })); return prevented; } };
  const g = global; g.CustomEvent = function (t, i) { this.type = t; this.detail = i && i.detail; };
  // the kit reads `root` = window; give the node-required instance a window-ish via a fresh require with globals
  const Kit = (() => { const keep = global.window; global.window = { CustomEvent: g.CustomEvent, LeadSnooze: null }; delete require.cache[require.resolve(path.join(ROOT, 'docs/pro/js/layouts/kit.js'))]; const m = require(path.join(ROOT, 'docs/pro/js/layouts/kit.js')); global.window = keep; return m; })();
  // `root` inside kit is evaluated at load: typeof window === 'undefined' in node -> null, so use handlers + the fallback path via a tiny shim
  const calls = [];
  rootEl.root = rootEl;
  const unbind = Kit.bind(rootEl, { photo: (it) => calls.push(['photo', it.id]), nav: (id) => calls.push(['nav', id]) },
    (id) => ({ id, name: 'N' + id }));
  const btn = el({ 'data-lk-act': 'photo', 'data-lead-id': 'L9' }, rootEl);
  const prevented = rootEl.click(btn);
  ok('a [data-lk-act] click calls the layout handler with the looked-up item and prevents default',
    calls.length === 1 && calls[0][0] === 'photo' && calls[0][1] === 'L9' && prevented === true);
  rootEl.click(el({ 'data-lk-nav': 'map' }, rootEl));
  ok('a [data-lk-nav] click calls the nav handler', calls[1] && calls[1][0] === 'nav' && calls[1][1] === 'map');
  const before = calls.length;
  rootEl.click(el({ 'data-lk-act': 'photo', 'data-lead-id': 'ZZ' }, null));   // outside the container
  ok('a click outside the container is ignored', calls.length === before);
  const prev2 = rootEl.click(el({}, rootEl));
  ok('a click on nothing actionable does not preventDefault (links keep working)', prev2 === false);
  // unhandled action -> bubbling event for the layout; snooze -> the CRM's own modal when present
  const evBefore = events.length;
  rootEl.click(el({ 'data-lk-act': 'done', 'data-lead-id': 'L7' }, rootEl));
  ok('an action with no handler is emitted as a bubbling nbd:layout-action event',
    events.length === evBefore + 1 && events[evBefore].type === 'nbd:layout-action'
    && events[evBefore].detail.action === 'done' && events[evBefore].detail.leadId === 'L7');
  const snoozed = [];
  const keepW = global.window;
  global.window = { CustomEvent: g.CustomEvent, LeadSnooze: { prompt: (id, nm) => snoozed.push([id, nm]) } };
  delete require.cache[require.resolve(path.join(ROOT, 'docs/pro/js/layouts/kit.js'))];
  const Kit2 = require(path.join(ROOT, 'docs/pro/js/layouts/kit.js'));
  global.window = keepW;
  const r2 = { _l: [], addEventListener(t, f) { this._l.push(f); }, removeEventListener() {}, contains: () => true, dispatchEvent() {} };
  Kit2.bind(r2, {}, (id) => ({ id, name: 'Pat' }));
  r2._l[0]({ target: el({ 'data-lk-act': 'snooze', 'data-lead-id': 'L5' }, null), preventDefault() {} });
  ok('snooze with no handler opens LeadSnooze.prompt(id, name)', snoozed.length === 1 && snoozed[0][0] === 'L5' && snoozed[0][1] === 'Pat');
  unbind();
  rootEl.click(btn);
  ok('unbind removes the listener', calls.length === before);
}

console.log('\n5. registry needs + css');
{
  R._reset();
  const d = R.register({ id: 'field', name: 'Field', script: 'js/layouts/field.js',
    needs: { script: ['js/layouts/kit.js', '//evil.example/x.js', 'js/layouts/../x.js', 'js/layouts/ok-2.js'], css: ['css/layouts/kit.css', 'http://x/y.css', 'css/other.css'] } });
  ok('needs keeps only js/layouts/*.js and css/layouts/*.css paths',
    d.needs.script.join() === 'js/layouts/kit.js,js/layouts/ok-2.js' && d.needs.css.join() === 'css/layouts/kit.css');
  ok('no needs -> empty lists', R.register({ id: 'plain' }).needs.script.length === 0);
  const css = read('docs/pro/css/layouts/kit.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const classes = css.match(/\.[a-z][a-z0-9_-]*/gi) || [];
  ok('every class in kit.css is lk-prefixed (cannot touch Classic)', classes.length > 20 && classes.every((c) => /^\.lk-/.test(c) || /^\.\d/.test(c)),
    classes.filter((c) => !/^\.lk-/.test(c)).slice(0, 5).join(' '));
  ok('no hard-coded brand colours: only var(--token) plus rgba shadow', !/#[0-9a-f]{3,8}\b/i.test(css.replace(/var\(--accent-fg,\s*#fff\)/g, '')));
  ok('actions are tap-sized by token', /min-height:\s*var\(--tap\)/.test(css));
  ok('no :root / html / body / element selectors', !/(^|[,{}\s])(:root|html|body|\*)\s*[{,]/m.test(css));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
