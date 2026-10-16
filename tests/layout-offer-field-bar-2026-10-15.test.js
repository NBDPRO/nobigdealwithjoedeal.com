#!/usr/bin/env node
/**
 * tests/layout-offer-field-bar-2026-10-15.test.js — day and night layouts,
 * Field's one-thumb action bar, and the sync dot in the full-screen layouts.
 *
 *   A. the offer rule: Field on a phone by day, Mission on a computer at night, never forced
 *   B. the banner: one tap switches for this session only; Not now / Don't ask again
 *   C. Field's action bar: Navigate / Call / Text (checked) / Photo / Collect
 *   D. the sync dot: online / offline / photos waiting, never a false "all uploaded"
 *   E. wiring: Settings panel, lazy bundle, kept across sign-out, CSP-clean
 *
 * Run: node tests/layout-offer-field-bar-2026-10-15.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const O = require(path.join(ROOT, 'docs/pro/js/layout-offer.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 500) : '')); failed++; }
}
const at = (h, m) => new Date(2026, 9, 15, h, m || 0).getTime();
const ALL = () => ['phone', 'tablet', 'desktop'];
const base = (o) => Object.assign({ nowMs: at(11), cfg: null, sun: null, surface: 'phone', current: 'classic', source: 'user', company: {}, surfacesOf: (id) => (id === 'field' ? ['phone', 'tablet'] : ALL()), seen: {} }, o || {});

(async () => {
  console.log('\nA. the offer rule');
  {
    ok('daytime on a phone: offer Field', (O.offerFor(base()) || {}).id === 'field');
    ok('daytime on a tablet: offer Field', (O.offerFor(base({ surface: 'tablet' })) || {}).id === 'field');
    ok('night on a computer: offer Mission Control', (O.offerFor(base({ nowMs: at(21), surface: 'desktop' })) || {}).id === 'mission');
    ok('daytime on a computer, night on a phone: nothing', O.offerFor(base({ surface: 'desktop' })) === null && O.offerFor(base({ nowMs: at(22) })) === null);
    ok('already on that layout: nothing', O.offerFor(base({ current: 'field' })) === null);
    ok('company lock: nothing', O.offerFor(base({ company: { locked: true } })) === null);
    ok('the company does not allow it: nothing', O.offerFor(base({ company: { allowed: ['classic', 'mission'] } })) === null);
    ok('the layout cannot show on this screen: nothing', O.offerFor(base({ surfacesOf: () => ['desktop'] })) === null && O.offerFor(base({ surfacesOf: () => null })) === null);
    ok('turned off in Settings: nothing', O.offerFor(base({ cfg: { off: true } })) === null);
    ok('a preview, a storm switch or an open dialog: nothing', O.offerFor(base({ source: 'preview' })) === null && O.offerFor(base({ source: 'storm' })) === null && O.offerFor(base({ busy: true })) === null);
    const o = O.offerFor(base());
    ok('answered once this day-period: not again until the next one', O.offerFor(base({ seen: { [o.key]: 1 } })) === null && (O.offerFor(base({ nowMs: at(11) + 86400000, seen: { [o.key]: 1 } })) || {}).id === 'field');
    const sun = { sunrise: new Date(at(7, 40)), sunset: new Date(at(18, 50)) };
    ok('"sunrise to sunset" uses auto-theme\'s sun times', O.periodAt(at(7, 30), {}, sun) === 'night' && O.periodAt(at(8), {}, sun) === 'day' && O.periodAt(at(18, 55), {}, sun) === 'night');
    ok('without sun times it falls back to 7 am to 7 pm', O.periodAt(at(6, 59), {}, null) === 'night' && O.periodAt(at(7), {}, null) === 'day' && O.periodAt(at(19), {}, null) === 'night');
    ok('the rep\'s own hours', O.periodAt(at(6), { hours: 'fixed', dayStart: 5, dayEnd: 17 }, sun) === 'day' && O.periodAt(at(17), { hours: 'fixed', dayStart: 5, dayEnd: 17 }, sun) === 'night');
    ok('bad hours are repaired (end before start -> 7 to 7)', JSON.stringify(O.cfgOf({ hours: 'fixed', dayStart: 18, dayEnd: 6 })) === JSON.stringify({ off: false, hours: 'fixed', dayStart: 7, dayEnd: 19 }) && O.cfgOf({ dayStart: 99 }).dayStart === 7);
  }

  console.log('\nB. the banner');
  {
    const listeners = {};
    const store = {};
    const applied = [], saved = [];
    const banner = { hidden: true, setAttribute() {}, set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h || ''; } };
    const doc = {
      hidden: false,
      createElement: () => banner,
      body: { appendChild() {} },
      querySelector: () => null,
      getElementById: () => null,
      addEventListener: (n, f) => { (listeners['d:' + n] = listeners['d:' + n] || []).push(f); },
    };
    const win = {
      document: doc,
      LayoutEngine: {
        current: () => ({ id: 'classic', source: 'user', surface: 'phone' }), surface: () => 'phone',
        prefs: () => ({ hydrated: true, company: {} }),
        apply: (id, o2) => { applied.push([id, o2 && o2.source]); return Promise.resolve(id); },
        saveUser: (p) => { saved.push(p); return Promise.resolve({ saved: true }); },
      },
      LayoutRegistry: { get: (id) => ({ id, surfaces: id === 'field' ? ['phone', 'tablet'] : ['phone', 'tablet', 'desktop'] }) },
      addEventListener: () => {},
    };
    const ctx = {
      window: win, document: doc, console, JSON, Object, Array, String, Number, Math, Date: class extends Date { constructor(...a) { if (!a.length) super(at(11)); else super(...a); } static now() { return at(11); } },
      localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
      setTimeout: () => 1, setInterval: () => 1,
    };
    vm.createContext(ctx);
    vm.runInContext(read('docs/pro/js/layout-offer.js'), ctx);
    ok('loading the file never switches anything', applied.length === 0 && saved.length === 0);
    win.NBDLayoutOffer.check();
    ok('it ASKS: "Switch to Field App?" with Switch / Not now / Don\'t ask again', banner.hidden === false && /Switch to Field App\?/.test(banner.innerHTML) && /data-lo="yes">Switch</.test(banner.innerHTML) && /data-lo="later">Not now</.test(banner.innerHTML) && /data-lo="never">Don't ask again</.test(banner.innerHTML), banner.innerHTML);
    ok('still nothing switched until a tap', applied.length === 0);
    const click = (a) => { const t = { getAttribute: () => a }; t.closest = () => t; (listeners['d:click'] || []).forEach((f) => f({ target: t, preventDefault() {} })); };
    click('yes');
    ok('one tap switches for this session (source "auto"), never saved as the rep\'s choice', applied.length === 1 && applied[0][0] === 'field' && applied[0][1] === 'auto' && saved.length === 0, JSON.stringify(applied));
    ok('…and that day-period is remembered so it does not ask again', /:day/.test(store.nbd_layout_offer_seen || ''));
    delete store.nbd_layout_offer_seen;
    win.NBDLayoutOffer.check();
    click('never');
    ok('"Don\'t ask again" turns the offer off (Settings can turn it back on)', JSON.parse(store.nbd_layout_offer).off === true && applied.length === 1);
    delete store.nbd_layout_offer_seen;
    win.NBDLayoutOffer.check();
    ok('…and it stays off', banner.hidden === true);
  }

  console.log('\nC. Field\'s one-thumb action bar');
  {
    const field = read('docs/pro/js/layouts/field.js');
    const fn = field.slice(field.indexOf('function barHtml('), field.indexOf('var lastNav'));
    ok('Navigate, Call, Text and Photo come from kit.js\'s one ActionBar', /K\.actionBar\(it, \['navigate', 'call', 'text', 'photo'\], \{ size: 'sm' \}\)/.test(fn));
    const K = require(path.join(ROOT, 'docs/pro/js/layouts/kit.js'));
    const bar = K.actionBar(K.fromLead({ id: 'L1', firstName: 'Dana', phone: '(859) 555-0100', address: '12 Elm St' }), ['navigate', 'call', 'text', 'photo'], { size: 'sm' });
    ok('Text is an sms: link held by phone-share.js\'s checkText (data-ps-check + the lead)', /<a class="lk-act lk-act-text" href="sms:\+18595550100" data-lk-link="text" data-ps-check="1" data-ps-lead="L1"/.test(bar), bar);
    ok('Photo is a button for this customer', /data-lk-act="photo" data-lead-id="L1"/.test(bar));
    ok('Collect opens Record payment for this customer\'s oldest open invoice (the one owed rule)', /R\.isOwedInvoice\(i\) && R\.owedDollarsOf\(i\) > 0/.test(field) && /href="\/pro\/customer\.html\?id=' \+ encodeURIComponent\(it\.id\) \+ '&amp;pay=' \+ encodeURIComponent\(inv\.id/.test(field));
    ok('nothing owed, or a viewer: Collect is a disabled button that says why', /aria-label="Collect: ' \+\s*\(viewer \? 'viewers cannot record a payment' : 'nothing owed'\)/.test(field));
    ok('not on the camera, the customer picker, or another app view', /if \(S\.screen === 'capture' \|\| S\.screen === 'pick' \|\| !homeActive\(\)\) return null;/.test(field));
    ok('the bar\'s Photo opens the camera for that customer', /closest\('\.fa-bar \[data-lk-act="photo"\]'\)/.test(field) && /S\.screen = 'capture';/.test(field));
    const css = read('docs/pro/css/layouts/field.css');
    ok('five 52px targets, and the shell above shrinks by the bar\'s height', /\.fa-bar \.lk-act \{[^}]*min-height: 52px/.test(css) && /\.fa-bar-on \.fa-root \{ bottom: calc\(var\(--tap\) \+ 13px \+ 80px/.test(css));
    ok('unmount clears the bar state', /classList\.remove\('fa-bar-on'\)/.test(field));
  }

  console.log('\nD. the sync dot');
  {
    const K = require(path.join(ROOT, 'docs/pro/js/layouts/kit.js'));
    ok('online, nothing waiting: "Online"', K.syncView({ online: true, queued: 0 }).text === 'Online' && K.syncView({ online: true, queued: 0 }).state === 'online');
    ok('photos still in the queue: "3 photos uploading"', K.syncView({ online: true, queued: 3 }).text === '3 photos uploading' && K.syncView({ online: true, queued: 3 }).state === 'waiting');
    ok('offline: says so, with the photos waiting', K.syncView({ online: false, queued: 1 }).text === 'Offline · 1 photo waiting' && K.syncView({ online: false, queued: null }).text === 'Offline · saved on this phone');
    ok('a count that cannot be read never claims "uploaded"', !/upload/i.test(K.syncView({ online: true, queued: null }).text));
    // run the real refresh against a stub document + PhotoEngine
    const els = [{ textContent: '', attrs: {}, getAttribute(k) { return this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = v; } }];
    const win = { document: { hidden: false, querySelectorAll: () => els }, navigator: { onLine: false }, PhotoEngine: { queuedPhotoCountDurable: () => Promise.resolve(2) }, addEventListener() {}, setInterval: () => 1 };
    const ctx = { window: win, module: undefined, Promise, String, Object, Array, console };
    vm.createContext(ctx);
    vm.runInContext(read('docs/pro/js/layouts/kit.js'), ctx);
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    ok('the real refresh reads the durable queue and paints every dot', els[0].textContent === 'Offline · 2 photos waiting' && els[0].attrs['data-state'] === 'offline', JSON.stringify(els[0]));
    win.PhotoEngine.queuedPhotoCountDurable = () => Promise.reject(new Error('idb'));
    win.navigator.onLine = true;
    win.NBDLayoutKit.refreshSync();
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    ok('a failed count read shows just "Online" (no false all-clear on photos)', els[0].textContent === 'Online', els[0].textContent);
    ['field', 'focus', 'crew', 'inbox', 'mission'].forEach((id) => ok(id + ' carries the sync dot in its own top bar', /K\.syncDot\(\)/.test(read('docs/pro/js/layouts/' + id + '.js'))));
    ok('the dot is a status, coloured by state', /\.lk-sync\[data-state="offline"\]::before/.test(read('docs/pro/css/layouts/kit.css')) && /role="status"/.test(K.syncDot()));
  }

  console.log('\nE. wiring');
  {
    const dash = read('docs/pro/dashboard.html');
    ok('Settings > Appearance has "Day and night layouts" right after Layouts', dash.indexOf('id="layoutOfferPanel"') > dash.indexOf('id="layoutsPanel"') && dash.indexOf('id="layoutOfferPanel"') < dash.indexOf('/stab-panel-appearance'));
    const js = read('docs/pro/js/layout-offer.js');
    ok('the panel: an on/off switch and Sunrise-to-sunset or the rep\'s own hours', /id="loOn"/.test(js) && /name="loHours" value="sun"/.test(js) && /name="loHours" value="fixed"/.test(js) && /id="loStart"/.test(js) && /id="loEnd"/.test(js));
    ok('it listens to auto-theme.js\'s day-cycle hook', /addEventListener\('nbd:auto-theme', autoCheck\)/.test(js) && /AT\.core\.sunForDate/.test(js));
    ok('lazy bundle "layoutoffer" (?v=), kicked by today-home.js', /layoutoffer: \[\s*'css\/layout-offer\.css\?v=\d+',\s*'js\/layout-offer\.js\?v=\d+'\s*\]/.test(read('docs/pro/js/script-loader.js')) && /loadBundle\('layoutoffer'\)/.test(read('docs/pro/js/today-home.js')));
    ok('per device, kept across sign-out', /'nbd_layout_offer', 'nbd_layout_offer_seen'/.test(read('docs/pro/js/nbd-auth.js')));
    ok('never calls saveUser: an offer is not a saved choice', !/saveUser/.test(js.replace(/\/\*[\s\S]*?\*\//g, '')));
    ok('CSP: no inline handlers or style attributes', !/\son[a-z]+=/i.test(js) && !/style=/.test(js));
    ok('an automated browser (navigator.webdriver) never gets the banner on its own', /w\.navigator\.webdriver === true\) return;/.test(js) && /setTimeout\(autoCheck, 1500\)/.test(js) && !/setTimeout\(check, 1500\)/.test(js));
    ok('banner buttons are 44px', /\.lo-btn\{[^}]*min-height:44px/.test(read('docs/pro/css/layout-offer.css')));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
