#!/usr/bin/env node
/**
 * tests/next-stop-2026-10-15.test.js — the "Next stop" card in every layout.
 *
 *   A. which stop is next (timed first, 30-minute grace, Field's done marks, all-day fallback)
 *   B. routeplan.js: directions in the phone's own maps app; draftOnMyWay is gated by checkText
 *   C. Mission Control's On my way goes through the same gated path
 *   D. the card in a browser-like sandbox: no draft before the check says yes, location only on tap
 *   E. wiring: lazy bundle, Home section, a slot in every full-screen layout, CSP-clean
 *
 * Run: node tests/next-stop-2026-10-15.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const RP = require(path.join(ROOT, 'docs/pro/js/layouts/routeplan.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 500) : '')); failed++; }
}

// ── a sandbox that runs next-stop.js like a browser would ─────────────
function sandbox(o) {
  const opt = o || {};
  const listeners = {};
  const home = { id: 'homeNextStop', hidden: true, innerHTML: '', firstChild: null, getAttribute: () => null };
  Object.defineProperty(home, 'innerHTML', { set(v) { this._h = v; this.firstChild = v ? {} : null; }, get() { return this._h || ''; } });
  const slot = { hidden: true, firstChild: null, getAttribute: (a) => (a === 'data-ns-variant' ? 'compact' : null) };
  Object.defineProperty(slot, 'innerHTML', { set(v) { this._h = v; this.firstChild = v ? {} : null; }, get() { return this._h || ''; } });
  const geoCalls = [];
  const doc = {
    hidden: false,
    getElementById: (id) => (id === 'homeNextStop' ? home : null),
    querySelectorAll: (sel) => (sel === '[data-ns-slot]' ? [slot] : []),
    addEventListener: (n, f) => { (listeners['doc:' + n] = listeners['doc:' + n] || []).push(f); },
    body: {},
  };
  const store = Object.assign({}, opt.storage || {});
  const win = {
    document: doc,
    _leadsLoaded: true,
    _leads: opt.leads || [],
    _companyProfile: { companyName: 'No Big Deal' },
    NBDToday: {
      compute: () => ({ appointments: opt.appointments || [] }),
      appointmentRows: () => opt.rawRows || [],
      appointmentsFailed: () => !!opt.failed,
    },
    NBDTodayPlan: { collectTodayItems: (x) => (opt.tomorrow ? [opt.tomorrow] : []) },
    NBDRoutePlan: RP,
    NBDPhoneShare: opt.phoneShare,
    addEventListener: (n, f) => { (listeners['win:' + n] = listeners['win:' + n] || []).push(f); },
    setTimeout: (f) => { f(); return 1; },
    setInterval: () => 1,
    requestAnimationFrame: (f) => f(),
  };
  const ctx = {
    window: win, document: doc, console,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    navigator: {
      userAgent: opt.ua || 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      permissions: { query: () => Promise.resolve({ state: opt.geoState || 'prompt' }) },
      geolocation: { getCurrentPosition: (ok2) => { geoCalls.push(1); ok2({ coords: { latitude: 39.10, longitude: -84.51 } }); } },
    },
    setTimeout: (f) => { f(); return 1; }, setInterval: () => 1, clearTimeout() {},
    Date, JSON, Math, String, Number, Array, Object, Promise, isFinite, encodeURIComponent,
  };
  win.navigator = ctx.navigator;
  vm.createContext(ctx);
  vm.runInContext(read('docs/pro/js/next-stop.js'), ctx);
  const click = (attrs) => {
    const t = { getAttribute: (a) => (a in attrs ? attrs[a] : null) };
    t.closest = () => t;
    (listeners['doc:click'] || []).forEach((f) => f({ target: t, preventDefault() {} }));
  };
  return { win, home, slot, geoCalls, click, flush: () => new Promise((r) => setImmediate(r)) };
}

const NOW = Date.now();
const stop = (key, minFromNow, extra) => Object.assign({ key, sortMs: NOW + minFromNow * 60000, allDay: false, timeLabel: 'soon', name: 'Dana Smith', address: '12 Elm St, Burlington, KY 41005', phone: '(859) 555-0100', leadId: 'L1' }, extra || {});

(async () => {
  console.log('\nA. which stop is next');
  {
    const ns = sandbox({}).win.NBDNextStop;
    const pick = ns._pickNext;
    const a = [stop('late', 120), stop('soon', 20), stop('past', -90), stop('just', -20)];
    const r = pick(a, NOW, {});
    ok('a stop that started under 30 minutes ago is still next (grace)', r.next && r.next.key === 'just', r.next && r.next.key);
    ok('earlier stops are skipped; later counts the rest', r.later === 2, r.later);
    ok('a stop Field marked done is never next', pick(a, NOW, { just: 1 }).next.key === 'soon');
    ok('an hour-old stop is not next', pick([stop('past', -90)], NOW, {}).next === null);
    ok('no timed stop left: an all-day job day (not done) is next', pick([stop('past', -90), stop('job', 0, { allDay: true, sortMs: null })], NOW, {}).next.key === 'job');
    ok('a crew job day with a 7 am start stays next until Field marks it done', pick([stop('job:L1/-', -600, { source: 'job' })], NOW, {}).next.key === 'job:L1/-' && pick([stop('job:L1/-', -600, { source: 'job' })], NOW, { 'job:L1/-': 1 }).next === null);
    ok('timed stops come before all-day ones', pick([stop('job', 0, { allDay: true, sortMs: null }), stop('soon', 20)], NOW, {}).next.key === 'soon');
    ok('the grace window is 30 minutes', ns.GRACE_MS === 30 * 60000);
  }

  console.log('\nB. routeplan.js: directions + the gated On my way');
  {
    ok('Apple Maps on an iPhone', RP.directionsUrl('12 Elm St', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)') === 'https://maps.apple.com/?daddr=12%20Elm%20St');
    ok('Google Maps directions elsewhere', RP.directionsUrl('12 Elm St', 'Mozilla/5.0 (Linux; Android 14)') === 'https://www.google.com/maps/dir/?api=1&destination=12%20Elm%20St');
    ok('no address -> no link', RP.directionsUrl('  ', 'iPhone') === '');

    const calls = [];
    const yes = { checkText: (o) => { calls.push(o); return Promise.resolve({ ok: true }); } };
    const r1 = await RP.draftOnMyWay({ phone: '(859) 555-0100', leadId: 'L1', first: 'Dana', minutes: 12, signOff: 'Joe' }, yes);
    ok('a YES from checkText gives the draft and an sms: link', r1.ok === true && /^sms:\+18595550100\?&body=/.test(r1.href) && /about 15 minutes/.test(r1.text), JSON.stringify(r1));
    ok('checkText was asked with the phone AND the lead', calls.length === 1 && calls[0].phone === '(859) 555-0100' && calls[0].leadId === 'L1', JSON.stringify(calls));
    const r2 = await RP.draftOnMyWay({ phone: '8595550100', leadId: 'L1' }, { checkText: () => Promise.resolve({ ok: false, reason: 'They replied STOP.' }) });
    ok('a NO shows the reason and drafts nothing', r2.ok === false && r2.reason === 'They replied STOP.' && !r2.href && !r2.text, JSON.stringify(r2));
    const r3 = await RP.draftOnMyWay({ phone: '8595550100', leadId: 'L1' }, null);
    ok('no checker loaded -> nothing drafted (fails closed)', r3.ok === false && /Nothing was drafted/.test(r3.reason) && !r3.href);
    const r4 = await RP.draftOnMyWay({ phone: '8595550100', leadId: 'L1' }, { checkText: () => Promise.reject(new Error('offline')) });
    ok('a check that cannot run -> nothing drafted', r4.ok === false && !r4.href);
    const r5 = await RP.draftOnMyWay({ phone: '8595550100', leadId: 'L1' }, { checkText: () => { throw new Error('boom'); } });
    ok('a checker that throws -> nothing drafted, never rejects', r5.ok === false && !r5.href);
    let asked = 0;
    const r6 = await RP.draftOnMyWay({ phone: '', leadId: 'L1' }, { checkText: () => { asked++; return Promise.resolve({ ok: true }); } });
    ok('no phone -> no draft, and the server is not asked', r6.ok === false && r6.code === 'no_phone' && asked === 0);
  }

  console.log('\nC. Mission Control uses the same gated path');
  {
    const m = read('docs/pro/js/layouts/mission.js');
    const fn = m.slice(m.indexOf('function onMyWay('), m.indexOf('// ── render', m.indexOf('function onMyWay(')));
    ok('onMyWay calls RP.draftOnMyWay with NBDPhoneShare', /RP\.draftOnMyWay\(\{[^;]*\}, W\.NBDPhoneShare\)/.test(fn), fn.slice(0, 300));
    ok('onMyWay builds no sms: link of its own', !/smsHref|sms:/.test(fn));
  }

  console.log('\nD. the card');
  {
    const leads = [{ id: 'L1', firstName: 'Dana', lat: 39.0, lng: -84.6 }];
    const ps = { n: 0, ok: false, checkText() { this.n++; return Promise.resolve(this.ok ? { ok: true } : { ok: false, reason: 'Outside texting hours (8am-9pm).' }); } };
    const sb = sandbox({ leads, appointments: [stop('appt:1', 25, { timeLabel: '2:00 pm' })], phoneShare: ps });
    sb.win.NBDNextStop.render();
    await sb.flush();
    const h = sb.home.innerHTML;
    ok('Home shows the next stop: time, name, full address', /Next stop/.test(h) && /2:00 pm/.test(h) && /Dana Smith/.test(h) && /12 Elm St, Burlington, KY 41005/.test(h), h.slice(0, 400));
    ok('the strip shows the town only', /Burlington/.test(sb.slot.innerHTML) && !/12 Elm St/.test(sb.slot.innerHTML), sb.slot.innerHTML.slice(0, 300));
    ok('Navigate opens Apple Maps on an iPhone', /href="https:\/\/maps\.apple\.com\/\?daddr=12%20Elm%20St/.test(h));
    ok('On my way is a button, and nothing on the card is an sms: link before the check', /data-ns="omw"/.test(h) && !/sms:/.test(h));
    ok('location is NOT asked for on load (permission is "prompt")', sb.geoCalls.length === 0);
    ok('without a fix it offers "Tap for drive time"', /Tap for drive time/.test(h));
    sb.click({ 'data-ns': 'drive' });
    await sb.flush();
    ok('a tap asks for location once, then shows the estimate labelled (est.)', sb.geoCalls.length === 1 && /About \d+ min drive · [\d.]+ mi \(est\.\)/.test(sb.home.innerHTML), sb.home.innerHTML.slice(0, 600));

    sb.click({ 'data-ns': 'omw', 'data-ns-key': 'appt:1' });
    await sb.flush(); await sb.flush();
    ok('On my way asked checkText; a NO shows its reason and no draft', ps.n === 1 && /Outside texting hours/.test(sb.home.innerHTML) && !/sms:/.test(sb.home.innerHTML), sb.home.innerHTML.slice(-500));
    ps.ok = true;
    sb.click({ 'data-ns': 'omw', 'data-ns-key': 'appt:1' });
    await sb.flush(); await sb.flush();
    const after = sb.home.innerHTML;
    ok('a YES shows the draft with the drive time and "Open in Messages"; nothing is sent', ps.n === 2 && /Draft text/.test(after) && /href="sms:\+18595550100\?&amp;body=/.test(after) && /Nothing is sent until you press Send/.test(after), after.slice(-700));

    const granted = sandbox({ leads, appointments: [stop('appt:1', 25)], geoState: 'granted' });
    granted.win.NBDNextStop.render();
    await granted.flush(); await granted.flush();
    ok('permission already granted: drive time without a tap', granted.geoCalls.length === 1);

    const esc = sandbox({ appointments: [stop('appt:x', 10, { name: '<img src=x onerror=alert(1)>' })] });
    esc.win.NBDNextStop.render();
    ok('names are escaped', !/<img/.test(esc.home.innerHTML) && /&lt;img/.test(esc.home.innerHTML));

    const none = sandbox({ appointments: [stop('past', -120)], tomorrow: { key: 'job:x', timeLabel: '7:00 am', name: 'Ben Albright', address: '1180 Placeholder Way, Montgomery, OH' } });
    none.win.NBDNextStop.render();
    ok('empty state: "No more stops today" and tomorrow\'s first', /No more stops today/.test(none.home.innerHTML) && /Tomorrow's first: <strong>7:00 am<\/strong> · Ben Albright/.test(none.home.innerHTML), none.home.innerHTML);
    const failed = sandbox({ appointments: [], failed: true });
    failed.win.NBDNextStop.render();
    ok('a failed appointment read says the list may be missing a stop', /could not load/.test(failed.home.innerHTML));
    const android = sandbox({ appointments: [stop('appt:1', 25)], ua: 'Mozilla/5.0 (Linux; Android 14)' });
    android.win.NBDNextStop.render();
    ok('Navigate opens Google Maps off Apple devices', /google\.com\/maps\/dir\/\?api=1&amp;destination=/.test(android.home.innerHTML));
  }

  console.log('\nE. wiring');
  {
    const sl = read('docs/pro/js/script-loader.js');
    const dash = read('docs/pro/dashboard.html');
    const th = read('docs/pro/js/today-home.js');
    ok('lazy bundle "nextstop" (css + routeplan + card, each ?v=), no boot <script> tag',
      /nextstop: \[\s*'css\/next-stop\.css\?v=\d+',\s*'js\/layouts\/routeplan\.js\?v=\d+',\s*'js\/next-stop\.js\?v=\d+'\s*\]/.test(sl) && !/<script[^>]*next-stop/.test(dash));
    ok('today-home.js kicks it at Home boot', /loadBundle\('nextstop'\)/.test(th));
    ok('#homeNextStop sits above the Needs-you strip and Today', dash.indexOf('id="homeNextStop"') > 0 && dash.indexOf('id="homeNextStop"') < dash.indexOf('id="homeAttention"') && dash.indexOf('id="homeAttention"') < dash.indexOf('id="todayPlan"'));
    ok('today-home exposes the raw rows and the failure flag', /appointmentRows: function/.test(th) && /appointmentsFailed: function/.test(th));
    ok('the appointment read reaches through tomorrow', /end\.getTime\(\) \+ 36 \* 3600 \* 1000/.test(th));
    const slots = { field: 'compact', focus: null, crew: 'compact', inbox: 'compact', mission: 'compact' };
    Object.keys(slots).forEach((id) => {
      const src = read('docs/pro/js/layouts/' + id + '.js');
      const re = new RegExp('data-ns-slot="' + id + '"' + (slots[id] ? ' data-ns-variant="' + slots[id] + '"' : ''));
      ok(id + ' leaves a [data-ns-slot]' + (slots[id] ? ' (compact strip)' : ''), re.test(src));
    });
    const field = read('docs/pro/js/layouts/field.js');
    ok('Field: the strip is at the top of Today, above the current stop', field.indexOf('data-ns-slot="field"') < field.indexOf('<section class="fa-now"'));
    const mission = read('docs/pro/js/layouts/mission.js');
    ok('Mission: the strip is right under the header, outside the map grid', /data-mc-slot="top"><\/div><div class="mc-ns" data-ns-slot="mission"/.test(mission));
    const js = read('docs/pro/js/next-stop.js'), css = read('docs/pro/css/next-stop.css');
    ok('CSP: no inline handlers or style attributes in the card', !/\son[a-z]+=/i.test(js) && !/style=/.test(js));
    ok('buttons are at least 44px tall', /\.ns-btn\{[^}]*min-height:44px/.test(css) && /\.ns-drive-btn\{[^}]*min-height:44px/.test(css));
    ok('theme tokens, no literal brand colours', !/#bd5728|#e8720c|#f08030/i.test(css));
    ok('nothing in the card sends: no fetch, no callable', !/fetch\(|httpsCallable/.test(js));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
