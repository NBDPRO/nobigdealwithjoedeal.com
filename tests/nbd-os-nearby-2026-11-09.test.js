/**
 * tests/nbd-os-nearby-2026-11-09.test.js - NBD OS P3 "Nearby": the member's leads
 * nearest to where they stand (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §8 P3).
 *
 * The widget sorts the leads already in memory (window._leads) by straight-line
 * distance from the lat / lng they carry (the fields maps-customers.js plots), with
 * Open / Call / Navigate (the action runner's verbs when it is loaded, the same
 * rules otherwise). The position is read ONLY on the Find nearby tap, through one
 * getCurrentPosition call: never watched, never written to storage, Firestore or any
 * request. A refused or failed read shows a plain line. Scope: the member's own
 * (and unowned) leads; "All you can see" only when the leads the CRM loaded for
 * their role hold a teammate's. Renderers live in os/nearby.js + os/nearby-logic.js,
 * the runtime ScriptLoader bundle 'osnearby' home.js registers on first paint.
 *
 * Run: node tests/nbd-os-nearby-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, read, makeWin, byKey, text, click, noComments } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const req = (p) => { try { return require(path.join(ROOT, p)); } catch (e) { return null; } };
const NL = req('docs/pro/js/os/nearby-logic.js');
const HL = req('docs/pro/js/os/home-logic.js');
const RUNNER = req('docs/pro/js/command-runner.js');
const tick = () => new Promise((r) => setImmediate(r));
const NB_JS = read('docs/pro/js/os/nearby.js');
const NBL_JS = read('docs/pro/js/os/nearby-logic.js');
const NB_CSS = read('docs/pro/css/os/nearby.css');
const HOME_JS = read('docs/pro/js/os/home.js');

// where the rep stands: a street in Cincinnati; leads east of it at growing distances
const HERE = { lat: 39.1000, lng: -84.5000 };
const at = (dLng) => ({ lat: HERE.lat, lng: HERE.lng + dLng });
const LEADS = [
  Object.assign({ id: 'far', firstName: 'Far', lastName: 'Away', userId: 'u1', phone: '(513) 555-0101', address: '9 Far Rd, Cincinnati, OH' }, at(0.2)),
  Object.assign({ id: 'near', firstName: 'Nia <b>Near</b>', userId: 'u1', phone: '513-555-0102', address: '1 Near St, Cincinnati, OH' }, at(0.005)),
  Object.assign({ id: 'mid', name: 'Mid Way', assignedTo: 'u1', address: '5 Mid Ave' }, { lat: String(HERE.lat), lng: String(HERE.lng + 0.05) }),
  Object.assign({ id: 'mate', firstName: 'Teammate', lastName: 'Lead', userId: 'u2', phone: '5135550104', address: '2 Mate Ct' }, at(0.001)),
  Object.assign({ id: 'unowned', firstName: 'Nobody', lastName: 'Owns', phone: '5135550105' }, at(0.03)),
  { id: 'nocoords', firstName: 'No', lastName: 'Coords', userId: 'u1', address: '7 Somewhere' },
  Object.assign({ id: 'gone', firstName: 'Deleted', userId: 'u1', deleted: true }, at(0.0001)),
  { id: 'zero', firstName: 'Zero', userId: 'u1', lat: 0, lng: 0 },
];

/** A geolocation stub that records every call and answers by hand. */
function geoStub() {
  const g = { calls: [], watches: 0, pending: null };
  g.api = {
    getCurrentPosition(ok, fail, opts) { g.calls.push(opts || null); g.pending = { ok, fail }; },
    watchPosition() { g.watches++; return 1; },
    clearWatch() {},
  };
  g.answer = (pos) => { const p = g.pending; g.pending = null; p.ok({ coords: { latitude: pos.lat, longitude: pos.lng, accuracy: 10 }, timestamp: H.NOW }); };
  g.refuse = (code) => { const p = g.pending; g.pending = null; p.fail({ code, message: 'nope' }); };
  return g;
}

async function mount(items, opts) {
  const o = opts || {};
  const phone = !!o.phone;
  const T = makeWin(Object.assign({ surface: phone ? 'phone' : 'desk', loader: true, leads: LEADS, role: 'sales_rep', home: phone ? { phone: items, desk: [] } : { phone: [], desk: items } }, o));
  const g = geoStub();
  if (o.geo !== false) T.W.navigator.geolocation = g.api;
  T.W._impl.mount({ surface: phone ? 'phone' : 'desktop' });
  for (let i = 0; i < 6; i++) await tick();
  const ph = phone ? T.document.getElementById('osPhone') : T.document.querySelector('.os-widgets');
  return { T, g, ph, card: (k) => byKey(ph, k) };
}
const find = (T, el) => click(T.dom, el.querySelector('[data-oshw-nb="find"]'));

(async () => {
  console.log('\n1. the pure half: coordinates, distance, order');
  ok('nearby-logic.js loads in Node', !!NL && typeof NL.nearest === 'function');
  if (!NL) { console.log('\n' + passed + ' passed, ' + (failed + 1) + ' failed'); process.exit(1); }
  ok('coordsOf: numbers and numeric strings (the maps backfill writes either)', J(NL.coordsOf({ lat: 39.1, lng: -84.5 })) === J({ lat: 39.1, lng: -84.5 }) && J(NL.coordsOf({ lat: '39.1', lng: ' -84.5 ' })) === J({ lat: 39.1, lng: -84.5 }));
  ok('coordsOf: missing, blank, words, booleans, out of range and 0,0 (a failed geocode) are no location',
    [{}, { lat: 39 }, { lat: '', lng: '' }, { lat: 'abc', lng: -84 }, { lat: true, lng: -84 }, { lat: 91, lng: 0 }, { lat: 39, lng: -181 }, { lat: 0, lng: 0 }, null, 'x'].every((l) => NL.coordsOf(l) === null));
  ok('miles: Cincinnati to Columbus is about 99 miles (great circle)', Math.abs(NL.miles({ lat: 39.1031, lng: -84.512 }, { lat: 39.9612, lng: -82.9988 }) - 99) < 3, NL.miles({ lat: 39.1031, lng: -84.512 }, { lat: 39.9612, lng: -82.9988 }));
  ok('miText: under a tenth, one decimal under 10, whole miles after', NL.miText(0.04) === 'Under 0.1 mi' && NL.miText(0.44) === '0.4 mi' && NL.miText(3) === '3.0 mi' && NL.miText(12.6) === '13 mi' && NL.miText(NaN) === '' && NL.miText(-1) === '');
  ok('miText rounds first, then picks the format: 9.95 to 9.99 is "10 mi", never "10.0 mi"', NL.miText(9.95) === '10 mi' && NL.miText(9.999) === '10 mi' && NL.miText(9.94) === '9.9 mi' && NL.miText(0.1) === '0.1 mi', [9.95, 9.999, 9.94, 0.1].map(NL.miText).join(' | '));
  {
    const r = NL.nearest(LEADS, HERE, { uid: 'u1', scope: 'mine', n: 10 });
    ok('nearest (mine): own and unowned leads with a location, nearest first', J(r.rows.map((x) => x.id)) === J(['near', 'unowned', 'mid', 'far']), J(r.rows.map((x) => x.id)));
    ok('a teammate\'s lead, a deleted lead, a lead with no location and one at 0,0 are left out', !r.rows.some((x) => ['mate', 'gone', 'nocoords', 'zero'].indexOf(x.id) !== -1));
    ok('located counts the leads in scope that have a location (4 of 6 live, own or unowned)', r.located === 4 && r.inScope === 6, J({ located: r.located, inScope: r.inScope }));
    ok('others: the list holds a teammate\'s lead', r.others === true);
    ok('each row: the distance as text and the street up to the first comma', r.rows[0].dist === '0.3 mi' && r.rows[0].street === '1 Near St' && r.rows[3].dist === '11 mi' && NL.nearest(LEADS, HERE, { uid: 'u1', scope: 'all', n: 1 }).rows[0].dist === 'Under 0.1 mi', J(r.rows.map((x) => [x.dist, x.street])));
    const all = NL.nearest(LEADS, HERE, { uid: 'u1', scope: 'all', n: 3 });
    ok('nearest (all): every live lead in memory, the teammate\'s first here, n caps it', J(all.rows.map((x) => x.id)) === J(['mate', 'near', 'unowned']), J(all.rows.map((x) => x.id)));
    const tie = NL.nearest([{ id: 'a', lat: 39.2, lng: -84.5 }, { id: 'b', lat: 39.2, lng: -84.5 }], HERE, { n: 2 });
    ok('a tie keeps the list order', J(tie.rows.map((x) => x.id)) === J(['a', 'b']));
    ok('no position: no rows (never a made-up distance), still counts what has a location', NL.nearest(LEADS, null, { uid: 'u1' }).rows.length === 0 && NL.nearest(LEADS, { lat: 0, lng: 0 }, { uid: 'u1' }).rows.length === 0 && NL.nearest(LEADS, null, { uid: 'u1' }).located === 4);
    ok('a member whose loaded leads are all their own: others is false', NL.nearest(LEADS.filter((l) => l.id !== 'mate'), HERE, { uid: 'u1' }).others === false);
    ok('garbage in: no rows, no throw', NL.nearest(null, HERE, {}).rows.length === 0 && NL.nearest([null, 5, 'x', { id: '' }], HERE, {}).rows.length === 0);
  }

  console.log('\n2. Open / Call / Navigate: the action runner\'s verbs');
  {
    const l = LEADS[0];
    const v = NL.verbs(l);
    ok('Open goes to the customer page, Call is tel:+1 digits, Navigate the Google Maps search link', J(v.map((x) => x.id)) === J(['open', 'call', 'nav']) && v[0].href === '/pro/customer.html?id=far' && v[1].href === 'tel:+15135550101' && v[2].href === 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(l.address) && v[2].ext === true, J(v));
    ok('Text is left out (the runner\'s own check gates texting)', !v.some((x) => x.id === 'text'));
    ok('no phone: no Call; no address: no Navigate', J(NL.verbs({ id: 'x', address: '1 A St' }).map((x) => x.id)) === J(['open', 'nav']) && J(NL.verbs({ id: 'x', phone: '5135550000' }).map((x) => x.id)) === J(['open', 'call']));
    ok('the command runner exports leadVerbs', !!RUNNER && !!RUNNER._pure && typeof RUNNER._pure.leadVerbs === 'function');
    if (RUNNER && RUNNER._pure) {
      const sample = LEADS.concat([{ id: 'q', phone: '1 (513) 555-0199', address: '12 Oak St, Cincinnati, OH 45202' }, { id: 'r', phoneDigits: '5135550000', address: '  ' }, { id: 's', phone: '555-01' }]);
      ok('parity: with the runner loaded, the same verbs as without it', sample.every((x) => J(NL.verbs(x, RUNNER._pure.leadVerbs)) === J(NL.verbs(x))), sample.map((x) => J(NL.verbs(x, RUNNER._pure.leadVerbs)) + ' vs ' + J(NL.verbs(x))).join('\n'));
      ok('parity: the fallback copy matches the runner\'s leadVerbs exactly', sample.every((x) => J(NL.ownVerbs(x)) === J(RUNNER._pure.leadVerbs(x))));
    }
    ok('a verb href that is not tel: or https: is dropped', J(NL.verbs({ id: 'x' }, () => [{ id: 'open' }, { id: 'call', href: 'javascript:alert(1)' }, { id: 'nav', href: 'http://x' }]).map((x) => x.id)) === J(['open']));
    ok('a lead id is URL-encoded in the Open link', NL.verbs({ id: 'a b&c' })[0].href === '/pro/customer.html?id=a%20b%26c');
  }

  console.log('\n3. location errors and the fix\'s life');
  ok('denied (code 1): a plain line on turning it on', NL.geoError({ code: 1 }).kind === 'denied' && /browser settings/.test(NL.geoError({ code: 1 }).text));
  ok('unavailable (2) and timeout (3): try again', NL.geoError({ code: 2 }).kind === 'unavailable' && NL.geoError({ code: 3 }).kind === 'timeout' && NL.geoError(null).kind === 'unavailable');
  ok('no geolocation at all: says the device can\'t', NL.geoError({ kind: 'none' }).kind === 'none');
  ok('a fix is used for 10 minutes, then asked for again', NL.fresh({ lat: 39, lng: -84, at: 1000 }, 1000 + 9 * 60000) && !NL.fresh({ lat: 39, lng: -84, at: 1000 }, 1000 + 10 * 60000) && !NL.fresh(null, 1) && !NL.fresh({ lat: 39, lng: -84, at: 5000 }, 1000));

  console.log('\n4. the catalog entry');
  const c = HL && HL.CATALOG.nearby;
  ok('nearby: S/M/L, default M, no reads, its own bundle, in Tools, needs the CRM view', !!c && J(c.sizes) === J(['s', 'm', 'l']) && c.def === 'm' && c.reads === 0 && c.bundle === 'osnearby' && c.cat === 'tools' && c.nav === 'crm', J(c));
  ok('it names customers: "In a home" never paints it', !!c && c.names === true && HL.actHides({ privacy: true }, 'nearby') && !HL.actHides({ phase: 'leads' }, 'nearby'));
  ok('listed in the catalog order (the Add sheet)', !!HL && HL.ids().indexOf('nearby') !== -1);
  ok('a saved Nearby survives normalize at each size', !!HL && ['s', 'm', 'l'].every((s) => J(HL.normalize({ v: 1, phone: [{ id: 'nearby', s }], desk: [] }).phone) === J([{ id: 'nearby', s }])));

  console.log('\n5. on the home: nothing asked until the tap');
  {
    const { T, g, card } = await mount([{ id: 'nearby', s: 'l' }]);
    const el = card('nearby-1');
    const t = text(el);
    ok('painted, with Find nearby and the one-line promise', !!el && /Nearby/.test(t) && /Find nearby/.test(t) && /Never saved/.test(t), t);
    ok('the bundle osnearby loaded once: its css, nearby-logic.js and nearby.js', J(T.W.ScriptLoader.calls.filter((b) => b === 'osnearby')) === J(['osnearby']) && J((T.W.ScriptLoader.bundles.osnearby || []).map((s) => s.replace(/\?.*$/, ''))) === J(['css/os/nearby.css', 'js/os/nearby-logic.js', 'js/os/nearby.js']), J(T.W.ScriptLoader.bundles.osnearby));
    ok('no location asked at mount, nothing watched', g.calls.length === 0 && g.watches === 0);
    T.W.dispatchEvent(new T.W.CustomEvent('nbd:data-refreshed'));
    for (let i = 0; i < 3; i++) await tick();
    ok('a repaint asks for nothing either', g.calls.length === 0 && g.watches === 0);
    ok('the scope choice shows (the rep\'s loaded leads hold a teammate\'s): Yours pressed', !!el.querySelector('[data-oshw-nb="mine"][aria-pressed="true"]') && !!el.querySelector('[data-oshw-nb="all"][aria-pressed="false"]'));

    const before = J(T.store);
    find(T, el);
    ok('Find nearby: one getCurrentPosition, never watchPosition', g.calls.length === 1 && g.watches === 0, J(g.calls));
    ok('it says it is looking while it waits', /Finding where you are/.test(text(el)), text(el));
    g.answer(HERE);
    for (let i = 0; i < 3; i++) await tick();
    const t2 = text(el);
    const names = el.querySelectorAll('.os-nb-row .os-hw-row-name').map((n) => n.textContent);
    ok('L: the four nearest of yours, nearest first', J(names) === J(['Nia <b>Near</b>', 'Nobody Owns', 'Mid Way', 'Far Away']), J(names));
    ok('names escaped (the <b> is text, not markup)', !el.querySelector('b'));
    ok('a teammate\'s lead is not listed under Yours', !/Teammate/.test(t2));
    ok('each row: its distance and street', /0\.3 mi · 1 Near St/.test(t2) && /11 mi · 9 Far Rd/.test(t2), t2);
    const rowNear = el.querySelectorAll('.os-nb-item')[0];
    ok('Open: the name links to the customer page', !!rowNear.querySelector('a.os-nb-row[href="/pro/customer.html?id=near"]'));
    const call = rowNear.querySelector('a.os-nb-verb[href="tel:+15135550102"]');
    ok('Call: a tel: link named for the customer', !!call && call.getAttribute('aria-label') === 'Call Nia <b>Near</b>' && call.textContent === 'Call', call && J(call.attrs));
    const nav = rowNear.querySelector('a.os-nb-verb[target="_blank"]');
    ok('Navigate: the maps link in a new tab, rel=noopener', !!nav && nav.getAttribute('href') === 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('1 Near St, Cincinnati, OH') && nav.getAttribute('rel') === 'noopener' && nav.textContent === 'Navigate', nav && J(nav.attrs));
    ok('a lead with no phone has no Call (Mid Way), one with no address no Navigate (Nobody Owns)', !el.querySelectorAll('.os-nb-item')[2].querySelector('a[href^="tel:"]') && !el.querySelectorAll('.os-nb-item')[1].querySelector('a[target="_blank"]'));
    ok('every 44px target: rows are .os-hw-row, verbs and buttons .os-hw-btn', el.querySelectorAll('.os-nb-verb').every((n) => n.classList.contains('os-hw-btn')) && el.querySelectorAll('[data-oshw-nb]').every((n) => n.classList.contains('os-hw-btn')));
    ok('focus moves to the nearest row', T.document.activeElement === el.querySelector('.os-nb-row'), T.document.activeElement && T.document.activeElement.tagName);
    ok('L: when the fix was taken, and Update', /From where you were at/.test(t2) && !!el.querySelector('.os-nb-head [data-oshw-nb="find"]'), t2);
    const nums = (t2.replace(/From where you were at[^A-Z]*/, '').match(/\d+(\.\d+)?/g) || []);
    ok('every number on it is a distance or a street number from the leads', nums.every((n) => ['0.3', '1', '1.6', '2.7', '5', '11', '9'].indexOf(n) !== -1), J(nums));

    console.log('\n6. the position is never kept or sent');
    ok('localStorage is exactly as it was', J(T.store) === before, J(T.store));
    ok('no layoutState or company save', !(T.W._saves || []).length && !(T.W._coSaves || []).length);
    ok('no Firestore read or write, no fetch', T.reads.length === 0, J(T.reads));
    ok('the widget\'s state holds no copy of the position', !/39\.1|84\.5/.test(J(T.W.NBDOSNearby.state())), J(T.W.NBDOSNearby.state()));
    const src = noComments(NB_JS + NBL_JS);
    ok('nearby.js / nearby-logic.js never touch storage, Firestore or the network',
      !/localStorage|sessionStorage|indexedDB|document\.cookie|caches\./.test(src)
      && !/\b(getDoc|getDocs|setDoc|updateDoc|addDoc|onSnapshot|httpsCallable|_httpsCallable)\s*\(/.test(src)
      && !/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|\bimport\s*\(/.test(src));
    ok('never watched: no watchPosition anywhere in it, getCurrentPosition once', !/watchPosition/.test(src) && (src.match(/getCurrentPosition\s*\(/g) || []).length === 1);
    ok('the position is never written into the page: no link or attribute carries it', !/39\.1|-84\.5|84\.5/.test(el.innerHTML), el.innerHTML.slice(0, 300));

    console.log('\n7. role scope');
    click(T.dom, el.querySelector('[data-oshw-nb="all"]'));
    const allNames = el.querySelectorAll('.os-nb-row .os-hw-row-name').map((n) => n.textContent);
    ok('All you can see: the teammate\'s lead the role already loads joins, nearest first', allNames[0] === 'Teammate Lead' && /^Nearby All$/.test(text(el.querySelector('.os-hw-title'))), J(allNames));
    ok('All pressed, focus stays on it, and no new location asked', !!el.querySelector('[data-oshw-nb="all"][aria-pressed="true"]') && T.document.activeElement === el.querySelector('[data-oshw-nb="all"]') && g.calls.length === 1);
    ok('the choice is memory only: still nothing stored or saved', J(T.store) === before && !(T.W._saves || []).length);
    click(T.dom, el.querySelector('[data-oshw-nb="mine"]'));
    ok('Yours again', !/Teammate/.test(text(el)));
    click(T.dom, el.querySelector('.os-nb-head [data-oshw-nb="find"]'));
    ok('Update asks again, once', g.calls.length === 2 && g.watches === 0);
    g.refuse(3);
    ok('a timeout on Update drops the old fix and says to try again', /took too long/.test(text(el)) && !el.querySelector('.os-nb-row'), text(el));
  }
  {
    const own = LEADS.filter((l) => l.id !== 'mate');
    const { T, g, card } = await mount([{ id: 'nearby', s: 'l' }], { leads: own });
    const el = card('nearby-1');
    ok('a member whose loaded leads are all theirs: no scope choice at all', !el.querySelector('[data-oshw-nb="all"]') && !/Yours/.test(text(el.querySelector('.os-hw-title'))));
    find(T, el); g.answer(HERE);
    ok('and none after a search', !el.querySelector('[data-oshw-nb="all"]') && el.querySelectorAll('.os-nb-row').length === 4);
  }

  console.log('\n8. refused, unavailable, missing');
  {
    const { T, g, card } = await mount([{ id: 'nearby', s: 'm' }]);
    const el = card('nearby-1');
    find(T, el); g.refuse(1);
    const t = text(el);
    ok('denied: a plain line, no rows, no number', /Location is off for this site/.test(t) && !el.querySelector('.os-nb-row') && !/\d/.test(t), t);
    ok('denied: Try again (a tap asks again; the browser decides)', /Try again/.test(t));
    ok('focus lands on the message', T.document.activeElement === el.querySelector('[data-oshw-nb-status]'));
    find(T, el);
    ok('Try again asks once more', g.calls.length === 2);
    g.refuse(2);
    ok('unavailable: couldn\'t find, try again', /Couldn't find your location/.test(text(el)));
  }
  {
    const { T, g, card } = await mount([{ id: 'nearby', s: 's' }]);
    const el = card('nearby-1');
    find(T, el);
    ok('S while it asks: the title says so (one 92px cell: a title line and one button)', /Finding you/.test(text(el.querySelector('.os-hw-title'))), text(el));
    g.refuse(1);
    ok('S denied: "Location off" in the title, then Try again; nothing else to clip', /Location off/.test(text(el.querySelector('.os-hw-title'))) && !el.querySelector('p') && /Try again/.test(text(el)), text(el));
  }
  {
    // Firefox: dismissing the prompt with "Not now" or X never calls back, and the spec's
    // timeout only counts once permission is granted, so a guard timer ends the wait
    const { T, g, card } = await mount([{ id: 'nearby', s: 'm' }]);
    const el = card('nearby-1');
    find(T, el);
    ok('a read that never answers: still asking at first', /Finding where you are/.test(text(el)) && g.calls.length === 1, text(el));
    T.fire(20000);
    ok('after 20 s with no answer: the timeout line and Try again', /took too long/.test(text(el)) && /Try again/.test(text(el)) && T.W.NBDOSNearby.state().asking === false, text(el));
    find(T, el);
    ok('Try again asks once more after the guard fired', g.calls.length === 2);
    g.answer(HERE);
    for (let i = 0; i < 3; i++) await tick();
    ok('an answer after a fresh ask lands normally', el.querySelectorAll('.os-nb-row').length === 2, text(el));
    T.fire(20000);
    ok('the first ask\'s guard, fired late, does not undo the newer answer', el.querySelectorAll('.os-nb-row').length === 2, text(el));
    const { T: T2, g: g2, card: card2 } = await mount([{ id: 'nearby', s: 'm' }]);
    const el2 = card2('nearby-1');
    find(T2, el2); g2.answer(HERE);
    for (let i = 0; i < 3; i++) await tick();
    T2.fire(20000);
    ok('an answered read: its guard timer is cleared and changes nothing', el2.querySelectorAll('.os-nb-row').length === 2 && T2.timers.filter((t) => t.ms === 20000 && t.fn).length === 0, text(el2));
  }
  {
    const { T, card } = await mount([{ id: 'nearby', s: 'm' }], { geo: false });
    const el = card('nearby-1');
    find(T, el);
    ok('no geolocation on the device: says so, no throw', /can't share a location/.test(text(el)) && !el.querySelector('.os-nb-row'), text(el));
  }
  {
    const { T, g, card } = await mount([{ id: 'nearby', s: 'm' }], { leads: [{ id: 'x', firstName: 'X', userId: 'u1', address: '1 A St' }] });
    const el = card('nearby-1');
    find(T, el); g.answer(HERE);
    ok('no lead with a location: a plain line, no number', /None of your leads has a map location yet/.test(text(el)) && !/\d/.test(text(el).replace(/Update/, '')), text(el));
  }
  {
    const { card } = await mount([{ id: 'nearby', s: 'm' }], { leadsLoaded: false });
    ok('leads not loaded yet: says so, no Find button', /Loading your leads/.test(text(card('nearby-1'))) && !card('nearby-1').querySelector('[data-oshw-nb="find"]'));
  }
  {
    const { T, g, card } = await mount([{ id: 'nearby', s: 'm' }], { phone: true });
    const el = card('nearby-1');
    find(T, el); g.answer(HERE);
    ok('M on the phone page: the two nearest, each with its verbs', el.querySelectorAll('.os-nb-item').length === 2 && /Nia/.test(text(el)) && /Nobody Owns/.test(text(el)), text(el));
  }
  {
    const { T, g, card } = await mount([{ id: 'nearby', s: 's' }]);
    const el = card('nearby-1');
    find(T, el); g.answer(HERE);
    const a = el.querySelector('a.os-nb-row');
    ok('S: the nearest one, a tap opens the map to it', !!a && /Nia/.test(text(a)) && /maps\/search/.test(a.getAttribute('href')) && /^Navigate to /.test(a.getAttribute('aria-label')) && !el.querySelector('.os-nb-verb'), a && J(a.attrs));
  }

  console.log('\n9. strict CSP, floors and the demo');
  ok('no style attributes, no inline handlers, no el.style writes', !/style\s*=|\.style\b|\son[a-z]+\s*=/i.test(noComments(NB_JS)));
  ok('home.js routes [data-oshw-nb] taps to NBDOSNearby.tap and repaints on nbd:os-nearby', /\[data-oshw-nb\]/.test(HOME_JS) && /NBDOSNearby\.tap/.test(HOME_JS) && /'nbd:os-nearby'/.test(HOME_JS));
  ok('nearby.css: tokens only, no motion, nothing under 11px', !/#[0-9a-f]{3,8}\b/i.test(NB_CSS.replace(/\/\*[\s\S]*?\*\//g, '')) && !/transition|animation/.test(NB_CSS) && !/font-size:\s*([0-9]|10)px/.test(NB_CSS));
  const demo = read('docs/pro/js/demo-mode.js');
  ok('the demo answers getCurrentPosition with the sample street (never the browser)', /geo\.getCurrentPosition\s*=\s*function/.test(demo) && /api\.position\(\)/.test(demo));
  ok('the bundle\'s files are same-origin, versioned paths', /var NB_BUNDLE = \['css\/os\/nearby\.css\?v=1', 'js\/os\/nearby-logic\.js\?v=1', 'js\/os\/nearby\.js\?v=1'\]/.test(HOME_JS));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
