/**
 * tests/nbd-os-wallpaper-picker-2026-11-09.test.js - NBD OS P1, wallpapers in
 * the running layout (the fake DOM of tests/lib/nbd-os-home-harness.js over the
 * REAL os.js, home-logic.js and the lazy os/wallpaper.js bundle):
 *
 *   1. each surface carries data-os-wp / data-os-tod; the period follows the
 *      clock tick the surface already runs (no new timer); Sunlight forces day
 *   2. the Wallpaper tile / desk button loads the 'oswp' ScriptLoader bundle
 *      (registered at runtime, not at boot) and opens a native <dialog>:
 *      Time of day, None, the member's My Skin pictures, More in My Skin settings
 *   3. a choice previews at once; Done saves the id for THIS surface only
 *      (one saveUser, the other surface kept); Close / Escape puts it back
 *   4. a chosen My Skin picture: painted through NBDMySkin.imageBlob as a blob:
 *      URL in --os-wp-img (CSSOM, never a style attribute, never saved),
 *      time of day until it is decoded; "Hide background pictures" or a picture
 *      that is gone keeps time of day; a new choice revokes the old URL
 *   5. a company-enforced My Skin background: the picker says so and only
 *      "More in My Skin settings" works
 *   6. zero reads, zero requests; every string escaped
 *
 * Run: node tests/nbd-os-wallpaper-picker-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const vm = require('vm');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, read, makeWin, NOW, click, fire, key, noComments } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 500) : '')); }
}
const J = (v) => JSON.stringify(v);
const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 8; i++) await tick(); };
const WP_SRC = read('docs/pro/js/os/wallpaper.js');
const OS_JS = read('docs/pro/js/layouts/os.js');

const PICS = [{ id: 'lq3x9a1b2c', theme: 'nbd-original', w: 9, h: 9, thumb: true }, { id: 'lq3x9a1b2d', theme: 'paper<b>', w: 9, h: 9, thumb: false }];
/** A window with a ScriptLoader that runs the real os/wallpaper.js, a My Skin stub and blob: URLs. */
function setup(opts) {
  const o = opts || {};
  const T = makeWin(Object.assign({ surface: 'phone', system: true, home: { phone: [{ id: 'glance', s: 'm' }], desk: [{ id: 'glance', s: 'm' }] } }, o));
  const W = T.W;
  W.loads = [];
  W.ScriptLoader = {
    bundles: {},
    loadBundle(name) {
      W.loads.push(name);
      (this.bundles[name] || []).forEach((f) => { const p = 'docs/pro/' + f.replace(/\?.*$/, ''); vm.runInContext(read(p), W, { filename: p }); });
      return Promise.resolve();
    },
  };
  W.urls = { made: [], revoked: [] };
  W.URL = { createObjectURL: (b) => { const u = 'blob:https://app.test/' + (W.urls.made.length + 1); W.urls.made.push(u); return u; }, revokeObjectURL: (u) => { W.urls.revoked.push(u); } };
  W.blobAsks = [];
  W.NBDMySkin = o.noSkin ? undefined : {
    state: () => ({ cfg: { hidePictures: !!o.hidePictures } }),
    images: () => (o.pics === undefined ? PICS : o.pics),
    imageBlob: (id, op) => { W.blobAsks.push(id + (op && op.thumb ? ':thumb' : '')); return Promise.resolve(o.gone ? null : { blob: { size: 9 }, dim: 0.62 }); },
  };
  if (o.locked) W.document.documentElement.classList.add('my-skin-locked');
  if (o.skinPainted) W.document.documentElement.classList.add('my-skin-wallpaper');
  if (o.sun) W.document.documentElement.classList.add('sun-all');
  return T;
}
function surfaceEl(T) { return T.document.getElementById(T.W._impl && T.W.NBDOSLayout.state().surface === 'phone' ? 'osPhone' : 'osDesk'); }
function css(el) {
  const props = {};
  el.style = { setProperty(k, v) { props[k] = v; }, removeProperty(k) { delete props[k]; } };
  return props;
}
const dialog = (T) => T.document.querySelector('dialog.os-wp-pick');
const radio = (d, v) => d.querySelectorAll('input').filter((i) => i.getAttribute('value') === v)[0];
function choose(T, d, v) { const r = radio(d, v); if (!r) return false; r.checked = true; fire(T.dom, r, 'change'); return true; }
async function openPicker(T) {
  const c = (T.W.controls || []).filter((x) => x.id === 'os-wallpaper')[0];
  c.run();
  await flush();
  return dialog(T);
}

(async () => {
  // ═════════════════════════════════════════════════════════════════════
  console.log('\n1. each surface paints its period from the clock it already runs');
  {
    const T = setup({ surface: 'phone' });
    const timers0 = T.timers.length;
    T.W._impl.mount({ surface: 'phone' });
    const el = T.document.getElementById('osPhone');
    ok('the phone home: data-os-wp="auto" (nothing chosen), data-os-tod="day" at 1:05 pm', el.getAttribute('data-os-wp') === 'auto' && el.getAttribute('data-os-tod') === 'day', J(el.attrs));
    const ints = T.timers.slice(timers0).filter((t) => t.kind === 'i');
    ok('no timer of its own: the phone runs the same two intervals as before (its 30 s clock and home.js\'s ticker)', ints.length === 2 && ints.every((t) => t.ms === 30000), J(ints.map((t) => t.ms)));
    T.W.Date.now = () => new Date(2026, 10, 9, 18, 30).getTime();
    T.fire(30000);
    ok('the next 30 s tick moves it to dusk at 6:30 pm', el.getAttribute('data-os-tod') === 'dusk', el.getAttribute('data-os-tod'));
    T.W.document.documentElement.classList.add('sun-all');
    (T.W.document.listeners['nbd:sunlight'] || []).forEach((f) => f({ type: 'nbd:sunlight' }));
    ok('Sunlight on: day at once (its nbd:sunlight event, not the next tick)', el.getAttribute('data-os-tod') === 'day');
    T.W._impl.unmount();

    const D = setup({ surface: 'desktop', home: { phone: [], desk: [{ id: 'glance', s: 'm' }], wp: { phone: null, desk: 'none' } } });
    D.W.Date.now = () => new Date(2026, 10, 9, 22, 0).getTime();
    D.W._impl.mount({ surface: 'desktop' });
    const de = D.document.getElementById('osDesk');
    ok('the desk: its own saved choice (none) and the night period', de.getAttribute('data-os-wp') === 'none' && de.getAttribute('data-os-tod') === 'night', J(de.attrs));
    ok('nothing loaded the wallpaper bundle for a built-in (lazy: only Wallpaper or a picture loads it)', D.W.loads.length === 0 && !D.W.NBDOSWallpaper);
    ok('the bundle is not in any page\'s boot: no <script> tag and no needs path for os/wallpaper.js',
      !/os\/wallpaper\.js/.test(read('docs/pro/dashboard.html')) && !/os\/wallpaper\.js/.test(read('docs/pro/js/layout-system.js')) && /SL\.bundles\[WP_BUNDLE\] = WP_FILES/.test(OS_JS));
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('\n2. Wallpaper opens the picker');
  {
    const T = setup({ surface: 'phone' });
    T.W._impl.mount({ surface: 'phone' });
    const d = await openPicker(T);
    ok('the Control Center tile loads the oswp bundle and opens a native <dialog> (showModal)', J(T.W.loads) === J(['oswp']) && d && d.tagName === 'DIALOG' && d.modal === true);
    ok('…not Settings first (that is "More in My Skin settings" now)', T.W.settingsTabs.length === 0 && T.W.goTos.length === 0);
    ok('…titled for this surface, and says the laptop keeps its own', /Wallpaper for this phone/.test(d.textContent) && /laptop keeps its own/.test(d.textContent));
    ok('Time of day (checked: the default) and None', radio(d, 'tod') && radio(d, 'tod').hasAttribute('checked') && radio(d, 'none') && !radio(d, 'none').hasAttribute('checked'));
    ok('the member\'s My Skin pictures, one radio each, by id', !!radio(d, PICS[0].id) && !!radio(d, PICS[1].id));
    ok('…labelled by number and theme, escaped (a theme name never becomes markup)', /Picture 1/.test(d.textContent) && /Picture 2/.test(d.textContent) && !d.querySelector('b') && /paper<b>/.test(d.textContent));
    ok('…their thumbnails come from My Skin as Blobs (thumb), shown as blob: URLs', T.W.blobAsks.indexOf(PICS[0].id + ':thumb') !== -1 && d.querySelectorAll('img').length === 2 && d.querySelectorAll('img').every((i) => /^blob:/.test(i.src || i.getAttribute('src') || '')), J(T.W.blobAsks));
    ok('"More in My Skin settings" is there', !!d.querySelector('[data-oswp-more]'));
    ok('My Skin was asked to load (its own bundle)', T.W.skinLoads >= 1);
    click(T.dom, d.querySelector('[data-oswp-more]'));
    ok('More in My Skin settings: the dialog closes and Settings opens at the My Skin panel', !dialog(T) && J(T.W.settingsTabs) === J(['appearance#myskinPanel']), J(T.W.settingsTabs));
    ok('closing revoked the thumbnails\' URLs', T.W.urls.made.filter((u) => T.W.urls.revoked.indexOf(u) === -1).length === 0, J(T.W.urls));

    const N = setup({ surface: 'phone', pics: [] });
    N.W._impl.mount({ surface: 'phone' });
    const nd = await openPicker(N);
    ok('no My Skin pictures: says so, offers no picture radio', /No My Skin pictures yet/.test(nd.textContent) && nd.querySelectorAll('input').length === 2);
    const Z = setup({ surface: 'phone', noSkin: true });
    Z.W._impl.mount({ surface: 'phone' });
    Z.W.NBDMySkin = undefined;
    const zp = (Z.W.controls || []).filter((x) => x.id === 'os-wallpaper')[0];
    zp.run(); await flush();
    for (let i = 0; i < 25; i++) { Z.fire(250); await flush(); }
    ok('My Skin never answers: the picker still works and says it has no pictures to list', /did not answer/.test(dialog(Z).textContent) && !!radio(dialog(Z), 'tod'));
    const P = setup({ surface: 'phone', skinPainted: true });
    P.W._impl.mount({ surface: 'phone' });
    const pd = await openPicker(P);
    ok('My Skin painting a picture and nothing chosen: None is checked (that is what shows)', radio(pd, 'none').hasAttribute('checked') && !radio(pd, 'tod').hasAttribute('checked'));
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('\n3. preview, Done saves this surface only, Close puts it back');
  {
    const T = setup({ surface: 'phone', home: { phone: [{ id: 'glance', s: 'm' }], desk: [{ id: 'upnext', s: 'l' }], wp: { phone: null, desk: 'none' } } });
    T.W._impl.mount({ surface: 'phone' });
    const el = T.document.getElementById('osPhone');
    let d = await openPicker(T);
    const saves0 = (T.W._saves || []).length;
    choose(T, d, 'none');
    ok('a choice previews on the surface at once', el.getAttribute('data-os-wp') === 'none');
    ok('…and saves nothing yet', (T.W._saves || []).length === saves0);
    click(T.dom, d.querySelector('[data-oswp-close]'));
    ok('Close: the saved choice is back (auto), still nothing saved', el.getAttribute('data-os-wp') === 'auto' && (T.W._saves || []).length === saves0 && !dialog(T));
    d = await openPicker(T);
    choose(T, d, 'none');
    key(T.dom, d, 'Escape');
    ok('Escape: the same', el.getAttribute('data-os-wp') === 'auto' && (T.W._saves || []).length === saves0 && !dialog(T));
    d = await openPicker(T);
    choose(T, d, 'none');
    choose(T, d, 'tod');
    click(T.dom, d.querySelector('[data-oswp-done]'));
    const s = (T.W._saves || []).slice(saves0);
    ok('Done: one saveUser of the os-home key', s.length === 1 && s[0].layoutState && Object.keys(s[0].layoutState).join() === 'os-home', J(s));
    const k = s[0] && s[0].layoutState['os-home'];
    ok('…the phone gets tod; the desk keeps none and its own widgets', k && J(k.wp) === J({ phone: 'tod', desk: 'none' }) && J(k.desk) === J([{ id: 'upnext', s: 'l', x: 0, y: 0, w: 2, h: 2 }]), J(k));   // the desk keeps its board cell (P1 board)
    ok('…the surface paints it and the dialog is gone', el.getAttribute('data-os-wp') === 'tod' && !dialog(T));
    d = await openPicker(T);
    ok('reopened: the saved choice is checked', radio(d, 'tod').hasAttribute('checked'));
    const n = (T.W._saves || []).length;
    click(T.dom, d.querySelector('[data-oswp-done]'));
    ok('Done with no change writes nothing', (T.W._saves || []).length === n);
    T.W._impl.unmount();

    const D = setup({ surface: 'desktop', home: { phone: [{ id: 'glance', s: 'm' }], desk: [{ id: 'glance', s: 'm' }], wp: { phone: 'none', desk: null } } });
    D.W._impl.mount({ surface: 'desktop' });
    click(D.dom, D.document.getElementById('osDesk').querySelector('[data-osdo="wallpaper"]'));
    await flush();
    const dd = dialog(D);
    ok('the desk column\'s Wallpaper button opens the same picker, for the desktop', dd && /Wallpaper for the desktop/.test(dd.textContent) && /phone keeps its own/.test(dd.textContent));
    choose(D, dd, 'tod');
    click(D.dom, dd.querySelector('[data-oswp-done]'));
    const ds = D.W._saves[D.W._saves.length - 1].layoutState['os-home'];
    ok('…and saves the desk only (the phone keeps none)', J(ds.wp) === J({ phone: 'none', desk: 'tod' }), J(ds.wp));
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('\n4. a My Skin picture on a surface');
  {
    const T = setup({ surface: 'phone', home: { phone: [{ id: 'glance', s: 'm' }], desk: [] } });
    T.W._impl.mount({ surface: 'phone' });
    const el = T.document.getElementById('osPhone');
    const props = css(el);
    const d = await openPicker(T);
    choose(T, d, PICS[0].id);
    ok('picking it: time of day shows while it decodes', el.getAttribute('data-os-wp') === 'tod' || el.getAttribute('data-os-wp') === 'img');
    await flush();
    ok('…then data-os-wp="img" with --os-wp-img a blob: URL and --os-wp-dim from My Skin\'s guard (62%)',
      el.getAttribute('data-os-wp') === 'img' && /^url\("blob:https:\/\/app\.test\/\d+"\)$/.test(props['--os-wp-img'] || '') && props['--os-wp-dim'] === '62%', J(props));
    ok('…read through NBDMySkin.imageBlob by id (full size)', T.W.blobAsks.indexOf(PICS[0].id) !== -1);
    ok('…set through the CSSOM, never a style attribute', !('style' in el.attrs));
    click(T.dom, d.querySelector('[data-oswp-done]'));
    await flush();
    const k = T.W._saves[T.W._saves.length - 1].layoutState['os-home'];
    ok('Done saves the image id only: no URL, no path anywhere in the key', k.wp.phone === PICS[0].id && !/blob:|https?:|skins\//.test(J(k)), J(k));
    const first = (props['--os-wp-img'] || '').replace(/^url\("|"\)$/g, '');
    const d2 = await openPicker(T);
    choose(T, d2, 'none');
    ok('a built-in again: the picture\'s URL is revoked and its properties removed', T.W.urls.revoked.indexOf(first) !== -1 && !props['--os-wp-img'] && el.getAttribute('data-os-wp') === 'none', J({ first, revoked: T.W.urls.revoked, props }));
    click(T.dom, d2.querySelector('[data-oswp-close]'));
    await flush();
    ok('Close puts the saved picture back (painted again)', el.getAttribute('data-os-wp') === 'img' && /^url\("blob:/.test(props['--os-wp-img'] || ''), el.getAttribute('data-os-wp'));
    const live = (props['--os-wp-img'] || '').replace(/^url\("|"\)$/g, '');
    T.W._impl.unmount();
    ok('unmount revokes it', T.W.urls.revoked.indexOf(live) !== -1);

    const Q = setup({ surface: 'phone', home: { phone: [{ id: 'glance', s: 'm' }], desk: [], wp: { phone: PICS[1].id, desk: null } } });
    Q.W._impl.mount({ surface: 'phone' });
    await flush();
    ok('a saved picture: the bundle loads on mount and paints it', J(Q.W.loads) === J(['oswp']) && Q.document.getElementById('osPhone').getAttribute('data-os-wp') === 'img');
    const X = setup({ surface: 'phone', hidePictures: true, home: { phone: [], desk: [], wp: { phone: PICS[1].id, desk: null } } });
    X.W._impl.mount({ surface: 'phone' });
    await flush();
    ok('"Hide background pictures" on: no picture, time of day', X.document.getElementById('osPhone').getAttribute('data-os-wp') === 'tod' && X.W.blobAsks.length === 0);
    const Y = setup({ surface: 'phone', gone: true, home: { phone: [], desk: [], wp: { phone: PICS[1].id, desk: null } } });
    Y.W._impl.mount({ surface: 'phone' });
    await flush();
    ok('a picture that is gone (not this member\'s, removed): time of day, no URL made', Y.document.getElementById('osPhone').getAttribute('data-os-wp') === 'tod' && Y.W.urls.made.length === 0);
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('\n5. a company-enforced My Skin background');
  {
    const T = setup({ surface: 'phone', locked: true });
    T.W._impl.mount({ surface: 'phone' });
    const d = await openPicker(T);
    ok('the picker says the company sets the background', /Your company sets the background/.test(d.textContent));
    ok('…every choice is off (the fieldset and each radio disabled) and so is Done', d.querySelector('fieldset').hasAttribute('disabled') && d.querySelectorAll('input').every((i) => i.hasAttribute('disabled')) && d.querySelector('[data-oswp-done]').hasAttribute('disabled'));
    const n = (T.W._saves || []).length;
    click(T.dom, d.querySelector('[data-oswp-done]'));
    ok('…Done does nothing', (T.W._saves || []).length === n && !!dialog(T));
    click(T.dom, d.querySelector('[data-oswp-more]'));
    ok('…"More in My Skin settings" still opens Settings', J(T.W.settingsTabs) === J(['appearance#myskinPanel']));
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('\n6. no reads, no requests, no store of its own');
  {
    const src = noComments(WP_SRC);
    ok('os/wallpaper.js: no Firestore, no fetch, no storage SDK, no localStorage', !/getDoc|setDoc|onSnapshot|fetch\(|getBlob|storage\b|localStorage|getDownloadURL/.test(src));
    ok('…no inline handler, no style attribute (CSSOM custom properties only)', !/\son[a-z]+=|style=/.test(src) && /style\.setProperty\('--os-wp-img'/.test(src));
    ok('…every interpolation in its markup goes through esc() (no raw im.theme / im.id / title)', !/\+ im\.(theme|id) \+|\+ title \+|\+ sub \+/.test(src));
    ok('os.js keeps no wallpaper store either (no getBlob, no storage ref, no new localStorage key)', !/getBlob|storageRef|ref\(\s*window\.storage|nbd_wallpaper/.test(noComments(OS_JS)));
    const T = setup({ surface: 'phone', home: { phone: [], desk: [], wp: { phone: PICS[0].id, desk: null } } });
    T.W._impl.mount({ surface: 'phone' });
    await flush();
    const d = await openPicker(T);
    choose(T, d, 'tod');
    click(T.dom, d.querySelector('[data-oswp-done]'));
    await flush();
    ok('a whole open / preview / save round: zero Firestore reads, zero fetches (the save is saveUser\'s own)', T.reads.length === 0, J(T.reads));
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('\n7. a paint that answers late never paints over a newer choice');
  {
    const T = setup({ surface: 'phone', home: { phone: [{ id: 'glance', s: 'm' }], desk: [] } });
    T.W._impl.mount({ surface: 'phone' });
    const el = T.document.getElementById('osPhone');
    const props = css(el);
    const pend = {};
    const thumbBlob = T.W.NBDMySkin.imageBlob;
    T.W.NBDMySkin.imageBlob = (id, op) => {
      if (op && op.thumb) return thumbBlob(id, op);
      T.W.blobAsks.push(id);
      return new Promise((res) => { pend[id] = () => res({ blob: { size: 9, id }, dim: 0.62 }); });
    };
    const d = await openPicker(T);
    choose(T, d, PICS[0].id);   // A: slow (not cached, Storage getBlob)
    await flush();
    choose(T, d, PICS[1].id);   // B: fast (IndexedDB)
    await flush();
    ok('(both pictures were asked for)', !!pend[PICS[0].id] && !!pend[PICS[1].id], J(Object.keys(pend)));
    const made0 = T.W.urls.made.length;
    pend[PICS[1].id]();
    await flush();
    const bUrl = T.W.urls.made[made0];
    ok('B answers first: B shows', el.getAttribute('data-os-wp') === 'img' && props['--os-wp-img'] === 'url("' + bUrl + '")', J(props));
    pend[PICS[0].id]();
    await flush();
    ok('A answers after: B still shows (A\'s late answer is dropped)', props['--os-wp-img'] === 'url("' + bUrl + '")' && T.W.urls.revoked.indexOf(bUrl) === -1, J({ props, urls: T.W.urls }));
    ok('…and A\'s URL, if one was made, is revoked at once', T.W.urls.made.slice(made0 + 1).every((u) => T.W.urls.revoked.indexOf(u) !== -1), J(T.W.urls));
    click(T.dom, d.querySelector('[data-oswp-done]'));
    await flush();
    ok('Done: B is saved and B is still on screen', T.W._saves[T.W._saves.length - 1].layoutState['os-home'].wp.phone === PICS[1].id && props['--os-wp-img'] === 'url("' + bUrl + '")', J(props));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('  ✗ the suite threw: ' + (e && e.stack)); process.exit(1); });
