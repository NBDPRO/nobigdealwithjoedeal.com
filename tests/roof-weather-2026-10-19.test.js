/**
 * tests/roof-weather-2026-10-19.test.js
 *
 * Grabber idea #11: roofing-weather chip on the Mission Control day route.
 * js/roof-weather.js (pure assess + cached weather.gov fetch) and its wiring in
 * layouts/mission.js behind the roofWeatherChip flag.
 *
 * Run: node tests/roof-weather-2026-10-19.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

function load(fetchImpl) {
  const win = { fetch: fetchImpl };
  win.window = win;
  vm.createContext(Object.assign(win, { Math, Number, String, isFinite, Promise, Date, Infinity, fetch: fetchImpl }));
  vm.runInContext(rd('docs/pro/js/roof-weather.js'), win);
  return win.NBDRoofWeather;
}
const P = (o) => Object.assign({ shortForecast: 'Mostly Sunny', windSpeed: '5 mph', temperature: 68, temperatureUnit: 'F', probabilityOfPrecipitation: { value: 0 } }, o);
const hrs = (n, o) => Array.from({ length: n }, () => P(o));

(async () => {
  const RW = load(() => Promise.reject(new Error('no net')));
  const A = RW.core.assess;

  console.log('\nassess');
  ok('calm dry day looks workable', A(hrs(8)).level === 'ok' && /^Looks workable/.test(A(hrs(8)).text));
  ok('wording never says "safe"', !/\bsafe\b/i.test(A(hrs(8)).text + A(hrs(8, { windSpeed: '30 mph' })).text));
  ok('thunder is poor', A([P(), P({ shortForecast: 'Chance Showers And Thunderstorms' })]).level === 'poor');
  ok('wind 25 mph is poor, 15 is check, 14 is ok',
    A(hrs(4, { windSpeed: '20 to 25 mph' })).level === 'poor' && A(hrs(4, { windSpeed: '10 to 15 mph' })).level === 'check' && A(hrs(4, { windSpeed: '14 mph' })).level === 'ok');
  ok('a gust counts', A(hrs(4, { windSpeed: '5 mph', windGust: '30 mph' })).level === 'poor');
  ok('rain chance 60 poor, 30 check, 29 ok',
    A(hrs(4, { probabilityOfPrecipitation: { value: 60 } })).level === 'poor' && A(hrs(4, { probabilityOfPrecipitation: { value: 30 } })).level === 'check' && A(hrs(4, { probabilityOfPrecipitation: { value: 29 } })).level === 'ok');
  ok('"slight chance of rain" at low odds is not wet', A(hrs(4, { shortForecast: 'Slight Chance Light Rain' })).level === 'ok');
  ok('steady rain text is poor even with null odds', A(hrs(4, { shortForecast: 'Rain', probabilityOfPrecipitation: { value: null } })).level === 'poor');
  ok('cold and hot are check, Celsius converts',
    A(hrs(4, { temperature: 30 })).level === 'check' && A(hrs(4, { temperature: 97 })).level === 'check' && A(hrs(4, { temperature: 0, temperatureUnit: 'C' })).level === 'check');
  ok('reasons are listed in the text', /wind up to 25 mph/.test(A(hrs(2, { windSpeed: '25 mph' })).text));
  ok('only the next 8 hours count (a storm at hour 9 is ignored)', A(hrs(8).concat([P({ shortForecast: 'Thunderstorms' })])).level === 'ok');
  ok('no data is unknown and says not an all-clear', A([]).level === 'unknown' && /Not an all-clear/.test(A([]).text) && A(null).level === 'unknown');

  console.log('\nforecast fetch');
  let calls = [];
  const fx = (url) => {
    calls.push(url);
    if (/\/points\//.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve({ properties: { forecastHourly: 'https://api.weather.gov/gridpoints/ILN/1,1/forecast/hourly' } }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ properties: { periods: hrs(8, { windSpeed: '30 mph' }) } }) });
  };
  const R2 = load(fx);
  let r = await R2.forecast(39.1, -84.5);
  ok('fetches points then hourly and assesses', r.level === 'poor' && calls.length === 2 && /api\.weather\.gov\/points\/39\.1000,-84\.5000/.test(calls[0]));
  await R2.forecast(39.12, -84.52);
  ok('same quarter-degree cell is cached (no new calls)', calls.length === 2);
  const R3 = load(() => Promise.resolve({ ok: false }));
  ok('HTTP failure -> unknown, never rejects', (await R3.forecast(39.1, -84.5)).level === 'unknown');
  ok('bad coordinates -> unknown without fetching', (await R2.forecast('x', null)).level === 'unknown' && calls.length === 2);

  console.log('\nMission wiring');
  const m = rd('docs/pro/js/layouts/mission.js');
  ok('chip is behind the roofWeatherChip flag (absent = off)', /F\.enabled\('roofWeatherChip'\)/.test(m) && /if \(!wxOn\(\) \|\| !model\.stops\.length\) return null/.test(m));
  ok('chip renders in the route panel and stop detail', /h \+= wxChip\(m\)/.test(m) && /\+ wxs \+ '<\/div>'/.test(m));
  ok('says forecast, not a safety clearance', /not a safety clearance/.test(m));
  ok('no crew-location claims added', !/crews? (are|is) (on|at)/i.test(m));
  ok('mission needs roof-weather.js lazily', /'js\/layouts\/kit\.js', 'js\/roof-weather\.js', 'js\/layouts\/mapview\.js'/.test(rd('docs/pro/js/layout-system.js')));

  console.log('\n─'.repeat(1) + '─'.repeat(49));
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})();
