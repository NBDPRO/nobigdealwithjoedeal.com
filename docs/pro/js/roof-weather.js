/**
 * roof-weather.js — window.NBDRoofWeather: a plain "is the weather workable
 * for roof work" read from the weather.gov hourly forecast (Grabber idea #11,
 * the weather chip on the Mission Control day route).
 *
 * It is a FORECAST read, never a safety clearance: the wording is "Looks
 * workable / Check conditions / Poor for roof work", never "safe". The crew
 * lead decides on the roof. The thresholds are conservative common-practice
 * numbers, not a standard, and live in core.LIMITS so they can be tuned:
 *
 *   Poor      thunder in the window, or gusts/wind >= 25 mph, or rain
 *             probability >= 60 %, or rain/snow/ice in the text
 *   Check     wind >= 15 mph, rain probability >= 30 %, temp <= 35 F or >= 95 F
 *   Workable  none of the above
 *
 * Window = the next 8 hourly periods from the first stop's location. Same
 * endpoints and cache pattern as js/auto-theme.js (points -> forecastHourly,
 * 30 min per quarter-degree cell). Nothing is stored or logged; if weather.gov
 * does not answer the chip says "Forecast unavailable. Not an all-clear."
 *
 * Gated by the `roofWeatherChip` feature flag in layouts/mission.js (absent =
 * off). Pure rules are tested in tests/roof-weather-2026-10-19.test.js.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  var W = window;

  var LIMITS = { windCheck: 15, windPoor: 25, popCheck: 30, popPoor: 60, tempLow: 35, tempHigh: 95, hours: 8 };
  var TTL_MS = 30 * 60000;

  /** "10 to 15 mph" / "5 mph" -> the larger number, or null. */
  function windMax(str) {
    var m = String(str == null ? '' : str).match(/\d+(\.\d+)?/g);
    if (!m) return null;
    return Math.max.apply(null, m.map(Number));
  }

  function tempF(p) {
    if (!p || p.temperature == null) return null;
    var t = Number(p.temperature);
    if (!isFinite(t)) return null;
    return String(p.temperatureUnit || 'F').toUpperCase() === 'C' ? t * 9 / 5 + 32 : t;
  }

  /** periods: weather.gov hourly periods. Returns { level, reasons[], text }. */
  function assess(periods) {
    var list = (periods || []).slice(0, LIMITS.hours);
    if (!list.length) return { level: 'unknown', reasons: [], text: 'Forecast unavailable. Not an all-clear.' };
    var poor = [], check = [];
    var thunder = false, wet = false, wind = 0, pop = 0, tmin = Infinity, tmax = -Infinity;
    list.forEach(function (p) {
      var txt = String(p.shortForecast || '');
      if (/thunder|lightning/i.test(txt)) thunder = true;
      if (/rain|shower|snow|sleet|freezing|ice|drizzle/i.test(txt) && !/slight chance|chance (of )?(light )?(rain|showers)/i.test(txt)) wet = true;
      var w = windMax(p.windSpeed); if (w != null && w > wind) wind = w;
      var gust = windMax(p.windGust); if (gust != null && gust > wind) wind = gust;
      var pp = p.probabilityOfPrecipitation && Number(p.probabilityOfPrecipitation.value);
      if (isFinite(pp) && pp > pop) pop = pp;
      var t = tempF(p); if (t != null) { if (t < tmin) tmin = t; if (t > tmax) tmax = t; }
    });
    if (thunder) poor.push('thunder in the forecast');
    if (wind >= LIMITS.windPoor) poor.push('wind up to ' + Math.round(wind) + ' mph');
    else if (wind >= LIMITS.windCheck) check.push('wind up to ' + Math.round(wind) + ' mph');
    if (pop >= LIMITS.popPoor || wet) poor.push(pop ? 'rain chance ' + Math.round(pop) + '%' : 'wet weather');
    else if (pop >= LIMITS.popCheck) check.push('rain chance ' + Math.round(pop) + '%');
    if (tmin !== Infinity && tmin <= LIMITS.tempLow) check.push('as cold as ' + Math.round(tmin) + ' F');
    if (tmax !== -Infinity && tmax >= LIMITS.tempHigh) check.push('as hot as ' + Math.round(tmax) + ' F');
    var level = poor.length ? 'poor' : (check.length ? 'check' : 'ok');
    var head = level === 'poor' ? 'Poor for roof work' : level === 'check' ? 'Check conditions' : 'Looks workable';
    var why = poor.concat(check);
    return { level: level, reasons: why, text: head + (why.length ? ': ' + why.join(', ') : '') + ' (next ' + list.length + ' h forecast)' };
  }

  var cache = {};   // cell -> { at, res }
  function cell(lat, lng) { return (Math.round(lat * 4) / 4).toFixed(2) + ',' + (Math.round(lng * 4) / 4).toFixed(2); }

  /** Promise<{level, reasons, text}>; never rejects (unknown on any failure). */
  function forecast(lat, lng) {
    lat = Number(lat); lng = Number(lng);
    var unknown = assess([]);
    if (!isFinite(lat) || !isFinite(lng) || typeof fetch !== 'function') return Promise.resolve(unknown);
    var key = cell(lat, lng), now = Date.now();
    if (cache[key] && now - cache[key].at < TTL_MS) return Promise.resolve(cache[key].res);
    var hdr = { headers: { 'User-Agent': 'NBDProCRM/1.0 (roofing-crm)', Accept: 'application/geo+json' } };
    return fetch('https://api.weather.gov/points/' + lat.toFixed(4) + ',' + lng.toFixed(4), hdr)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var url = j && j.properties && j.properties.forecastHourly;
        return url ? fetch(url, hdr).then(function (r) { return r.ok ? r.json() : null; }) : null;
      })
      .then(function (j) {
        var periods = j && j.properties && j.properties.periods;
        if (!periods || !periods.length) return unknown;
        var res = assess(periods);
        cache[key] = { at: Date.now(), res: res };
        return res;
      })
      .catch(function () { return unknown; });
  }

  W.NBDRoofWeather = { core: { LIMITS: LIMITS, windMax: windMax, assess: assess, cell: cell }, forecast: forecast, _clear: function () { cache = {}; } };
})();
