/**
 * tests/auto-theme-rules.test.js — Auto theme day cycle + rules (roadmap C1).
 *
 * Pure logic (NOAA sunrise/sunset, phases, rule resolution, config repair,
 * rain parsing) is exercised straight from docs/pro/js/auto-theme.js, and the
 * browser glue (hand-pick pauses until midnight, never switch under an open
 * modal, holds, saved theme untouched) runs in a vm sandbox with an INJECTED
 * clock — never wall time.
 *
 * Run: node tests/auto-theme-rules.test.js
 */
'use strict';
// The sun is computed for the device's LOCAL calendar date, so pin the zone the
// fixtures below are written in (CI runs in UTC).
process.env.TZ = 'America/New_York';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = path.join(__dirname, '..', 'docs', 'pro', 'js', 'auto-theme.js');
const core = require(FILE);

let passed = 0, failed = 0;
if (new Date(2026, 5, 21, 12).getTimezoneOffset() !== 240) { console.log('  ✗ TZ pin did not take (offset ' + new Date(2026, 5, 21, 12).getTimezoneOffset() + ')'); process.exit(1); }
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const minutesApart = (a, b) => Math.abs(a - b) / 60000;

console.log('\nAUTO THEME — solar calculation (Cincinnati)');
{
  const LAT = 39.1031, LNG = -84.512;
  const jun = core.solarTimes(2026, 5, 21, LAT, LNG);
  // Published: sunrise ~6:08 AM EDT = 10:08 UTC, sunset ~9:05 PM EDT = 01:05 UTC next day
  ok('June solstice sunrise within 6 min of 10:08 UTC', minutesApart(jun.sunrise.getTime(), Date.UTC(2026, 5, 21, 10, 8)) <= 6, jun.sunrise.toISOString());
  ok('June solstice sunset within 6 min of 01:05 UTC next day', minutesApart(jun.sunset.getTime(), Date.UTC(2026, 5, 22, 1, 5)) <= 6, jun.sunset.toISOString());
  const dec = core.solarTimes(2026, 11, 21, LAT, LNG);
  // Published: sunrise ~7:51 AM EST = 12:51 UTC, sunset ~5:22 PM EST = 22:22 UTC
  ok('December solstice sunrise within 6 min of 12:51 UTC', minutesApart(dec.sunrise.getTime(), Date.UTC(2026, 11, 21, 12, 51)) <= 6, dec.sunrise.toISOString());
  ok('December solstice sunset within 6 min of 22:22 UTC', minutesApart(dec.sunset.getTime(), Date.UTC(2026, 11, 21, 22, 22)) <= 6, dec.sunset.toISOString());
  ok('day is longer in June than December', (jun.sunset - jun.sunrise) > (dec.sunset - dec.sunrise) + 3 * 3600000);
  ok('polar day above the arctic circle in June', core.solarTimes(2026, 5, 21, 80, 0).polar === 'day');
  ok('polar night above the arctic circle in December', core.solarTimes(2026, 11, 21, 80, 0).polar === 'night');
}

console.log('\nAUTO THEME — phases');
{
  const sun = { sunrise: new Date(Date.UTC(2026, 0, 1, 12, 0)), sunset: new Date(Date.UTC(2026, 0, 1, 22, 0)), polar: null };
  const at = (h, m) => Date.UTC(2026, 0, 1, h, m || 0);
  ok('3am is night', core.phaseAt(at(3), sun) === 'night');
  ok('30 min before sunrise is dawn', core.phaseAt(at(11, 30), sun) === 'dawn');
  ok('29 min before sunrise is still night', core.phaseAt(at(11, 29), sun) === 'night');
  ok('60 min after sunrise is day', core.phaseAt(at(13, 0), sun) === 'day');
  ok('59 min after sunrise is still dawn', core.phaseAt(at(12, 59), sun) === 'dawn');
  ok('60 min before sunset is dusk', core.phaseAt(at(21, 0), sun) === 'dusk');
  ok('30 min after sunset is night', core.phaseAt(at(22, 30), sun) === 'night');
  ok('polar day stays day', core.phaseAt(at(3), { polar: 'day' }) === 'day');
  ok('polar night stays night', core.phaseAt(at(12), { polar: 'night' }) === 'night');
}

console.log('\nAUTO THEME — rule resolution');
{
  const noon = Date.UTC(2026, 5, 21, 17, 0); // 1 pm EDT, mid-day Cincinnati
  const mk = (over) => Object.assign(core.defaultConfig('paper', 'nbd-original'), over || {});
  ok('day cycle picks the day theme at midday', core.resolve(mk(), noon, {}).theme === 'paper' && core.resolve(mk(), noon, {}).rule === 'cycle');
  ok('night phase picks the night theme', core.resolve(mk(), Date.UTC(2026, 5, 22, 5, 0), {}).theme === 'nbd-original');
  ok('storm beats the day cycle', core.resolve(mk(), noon, { storm: true }).theme === 'storm-season');
  ok('storm rule switched off falls through to the cycle', core.resolve(mk({ off: ['storm'] }), noon, { storm: true }).rule === 'cycle');
  const site = mk({ jobSiteTheme: 'paper-high' });
  ok('customer-address rule wins over the cycle when a theme is set', core.resolve(site, noon, { onJobSite: true }).rule === 'jobsite');
  ok('customer-address rule with no theme chosen is skipped', core.resolve(mk(), noon, { onJobSite: true }).rule === 'cycle');
  const rain = mk({ rainTheme: 'storm-season', picks: { dawn: '', day: '', dusk: '', night: '' } });
  ok('empty cycle picks fall through to rain', core.resolve(rain, noon, { raining: true }).rule === 'rain');
  ok('rain only when raining', core.resolve(rain, noon, { raining: false }).rule === null);
  const fb = mk({ fallback: 'ember', picks: { dawn: '', day: '', dusk: '', night: '' } });
  ok('fallback is last', core.resolve(fb, noon, {}).theme === 'ember' && core.resolve(fb, noon, {}).rule === 'fallback');
  const reordered = mk({ order: ['rain', 'cycle', 'storm', 'jobsite', 'fallback'], rainTheme: 'ember' });
  ok('reordering rules changes the winner', core.resolve(reordered, noon, { raining: true }).rule === 'rain');
  const extra = [{ id: 'layout', fn: (c) => (c.raining ? 'ember' : null) }];
  ok('a registered extra rule is consulted before the fallback', core.resolve(mk({ off: ['cycle'] }), noon, { raining: true }, extra).rule === 'layout');
  ok('a throwing extra rule is skipped, not fatal', core.resolve(mk(), noon, {}, [{ id: 'boom', fn() { throw new Error('x'); } }]).rule === 'cycle');
  const t11 = Date.UTC(2026, 5, 21, 11, 30);
  ok('user location moves the sun: 11:30 UTC is day in Cincinnati but still night in Seattle', core.resolve(mk(), t11, {}).phase === 'day' && core.resolve(mk({ lat: 47.6, lng: -122.3 }), t11, {}).phase === 'night');
}

console.log('\nAUTO THEME — config repair');
{
  const bad = core.normalizeConfig({ enabled: 'yes', order: ['fallback', 'nope', 'fallback', 'cycle'], off: ['rain', 'zzz'], picks: { day: 5, dusk: 'ember' }, lat: 'x', lng: 4, gps: 1 });
  ok('non-boolean enabled is false', bad.enabled === false);
  ok('order keeps known ids, drops dupes, appends the missing', JSON.stringify(bad.order) === JSON.stringify(['fallback', 'cycle', 'storm', 'jobsite', 'rain']), JSON.stringify(bad.order));
  ok('off keeps only known ids', JSON.stringify(bad.off) === '["rain"]');
  ok('bad pick keeps the default, good pick is taken', bad.picks.day === 'paper' && bad.picks.dusk === 'ember');
  ok('half-set / invalid location is dropped', bad.lat === null && bad.lng === null);
  ok('gps must be exactly true', bad.gps === false);
  const legacy = core.normalizeConfig(null, 'zen', 'noir');
  ok('legacy nbd_auto_theme_day/night seed the picks', legacy.picks.day === 'zen' && legacy.picks.night === 'noir');
  ok('null config is the defaults', core.normalizeConfig(undefined).enabled === false);
}

console.log('\nAUTO THEME — rain parsing');
{
  ok('60% chance of precipitation counts', core.isRainyPeriod({ probabilityOfPrecipitation: { value: 60 }, shortForecast: 'Cloudy' }));
  ok('"Showers" counts', core.isRainyPeriod({ probabilityOfPrecipitation: { value: null }, shortForecast: 'Showers Likely' }));
  ok('"Slight Chance Light Rain" does not', !core.isRainyPeriod({ probabilityOfPrecipitation: { value: 20 }, shortForecast: 'Slight Chance Light Rain' }));
  ok('sunny does not', !core.isRainyPeriod({ probabilityOfPrecipitation: { value: 0 }, shortForecast: 'Sunny' }));
  ok('missing period does not', !core.isRainyPeriod(null));
}

// ── browser glue in a vm sandbox, injected clock ───────────────────
function harness(opts) {
  opts = opts || {};
  const listeners = {};
  const store = Object.assign({}, opts.storage || {});
  const applied = [];
  let current = opts.current || 'nbd-original';
  let modalOpen = false;
  const document = {
    readyState: 'complete',
    hidden: false,
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    getElementById() { return null; },
    querySelector() { return modalOpen ? {} : null; },
    dispatchEvent(ev) { (listeners[ev.type] || []).forEach((f) => f(ev)); },
    activeElement: null,
  };
  const ThemeEngine = {
    getCurrent: () => current,
    get: (k) => (k === 'ghost' ? null : { name: k }),
    isUnlocked: (k) => k !== 'locked-one',
    getAll: () => ({}),
    apply(k, save, o) {
      applied.push({ key: k, save, opts: o });
      current = k;
      document.dispatchEvent({ type: 'themechange', detail: k });
    },
  };
  const win = {
    ThemeEngine, document, addEventListener() {},
    nbdModal: { anyOpen: () => modalOpen },
  };
  win.window = win;
  const sb = {
    window: win, document,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    navigator: {}, console, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    Date, Math, JSON, Object, Array, Number, String, isFinite,
  };
  vm.runInNewContext(fs.readFileSync(FILE, 'utf8'), sb, { filename: 'auto-theme.js' });
  const A = win.NBDAutoTheme;
  A._resetForTest();
  let now = opts.now || Date.UTC(2026, 5, 21, 17, 0); // 1 pm EDT
  A._setClock(() => now);
  return {
    A, applied, store, document,
    setNow(n) { now = n; },
    setModal(v) { modalOpen = v; },
    userPicks(k) { current = k; document.dispatchEvent({ type: 'themechange', detail: k }); },
    current: () => current,
  };
}

console.log('\nAUTO THEME — scheduler glue (injected clock)');
{
  const h = harness();
  h.A.setEnabled(true);
  ok('enabling applies the day theme once', h.applied.length === 1 && h.applied[0].key === 'paper');
  ok("automatic switches never save (the user's own theme stays saved)", h.applied.every((a) => a.save === false));
  ok('automatic switches ask the engine for the Theme Morph (user-facing, unsaved)', h.applied.every((a) => a.opts && a.opts.morph === true));
  ok('the Comfort flag key is written', h.store.nbd_auto_theme === '1');
  h.A.tick();
  ok('a second tick with nothing changed does not re-apply', h.applied.length === 1);

  // dusk arrives
  h.setNow(Date.UTC(2026, 5, 22, 0, 40)); // 8:40 pm EDT, inside dusk
  h.A.tick();
  ok('dusk switches to the dusk pick', h.current() === 'nbd-original' && h.applied.length === 2);
  ok('our own switch did not pause Auto', h.A.status().paused === false);

  // hand pick
  h.userPicks('ember');
  ok('hand-picking pauses Auto', h.A.status().paused === true);
  const until = h.A.status().pausedUntil;
  const ref = new Date(Date.UTC(2026, 5, 22, 0, 40));
  ok('pause ends at the next LOCAL midnight', until === new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + 1).getTime());
  h.setNow(Date.UTC(2026, 5, 22, 2, 0));
  h.A.tick();
  ok('paused: tick does not fight the hand pick', h.current() === 'ember');
  h.setNow(until + 60000);
  h.A.tick();
  ok('after midnight Auto resumes', h.current() !== 'ember' && h.A.status().paused === false);
}
{
  const h = harness({ current: 'paper' });
  h.A.setEnabled(true); // already on day theme -> nothing to apply
  h.setNow(Date.UTC(2026, 5, 22, 5, 0)); // deep night
  h.setModal(true);
  h.A.tick();
  ok('never switches while a modal is open', h.current() === 'paper');
  h.setModal(false);
  h.A.tick();
  ok('applies on the next tick once the modal closes', h.current() === 'nbd-original');
}
{
  const h = harness();
  h.A.setEnabled(true);
  h.A.hold('storm-mode');
  h.setNow(Date.UTC(2026, 5, 22, 5, 0));
  h.A.tick();
  ok('a hold freezes the scheduler', h.current() === 'paper' && h.A.status().held === true);
  h.userPicks('storm-season');
  ok('a theme change during a hold does not pause Auto', h.A.status().paused === false);
  h.A.release('storm-mode');
  ok('release lets the rules apply again', h.current() === 'nbd-original');
}
{
  const h = harness();
  h.A.setEnabled(true);
  h.A.setContext({ storm: true });
  ok('storm context applies Storm Season through the rule engine', h.current() === 'storm-season');
  h.A.setContext({ storm: false });
  ok('all-clear returns to the cycle theme', h.current() === 'paper');
}
{
  const h = harness();
  h.A.update((c) => { c.picks.day = 'locked-one'; c.enabled = true; });
  h.A.tick();
  ok('a locked theme is never applied', !h.applied.some((a) => a.key === 'locked-one'));
  const h2 = harness();
  h2.A.update((c) => { c.picks.day = 'ghost'; c.enabled = true; });
  h2.A.tick();
  ok('an unknown theme id is never applied', !h2.applied.some((a) => a.key === 'ghost'));
}
{
  const h = harness();
  h.A.setEnabled(true);
  const before = h.applied.length;
  h.A.setEnabled(false);
  h.setNow(Date.UTC(2026, 5, 22, 5, 0));
  h.A.tick();
  ok('disabled: no further switches and the flag is cleared', h.applied.length === before && !('nbd_auto_theme' in h.store));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
