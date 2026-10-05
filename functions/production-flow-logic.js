/**
 * functions/production-flow-logic.js — the pure server half of the
 * after-contract production flow (2026-10-04).
 *
 * The audit behind it: 8 committed jobs in prod, only 2 with a date; no lead
 * had ever sat in Permit / Materials Ordered / Materials Here / Crew
 * Scheduled; 30 finished jobs with 0 After photos. Jo approved the whole
 * group; this file holds the rules the Cloud Functions share:
 *
 *   - the free weather.gov forecast, boiled down to one line per job day
 *     (it WARNS only — nothing is ever blocked on weather);
 *   - "the morning after the last job day" for the Install-Done push;
 *   - "signed jobs that need a week" for the morning brief.
 *
 * Crews are INDEPENDENT SUBCONTRACTORS who carry their own insurance. Nothing
 * here, or anything built on it, calls them employees or "our team".
 *
 * No I/O: job-weather.js fetches and caches, push-functions.js and
 * morning-brief.js read Firestore.
 */
'use strict';

const SW = require('./schedule-window');

const TZ = 'America/New_York';

// Committed work — the same list as the Plan Jobs panel's READY
// (docs/pro/js/schedule-planner-logic.js): signed through installing, plus
// approved service and warranty visits.
const COMMITTED = ['contract_signed', 'job_created', 'permit_pulled', 'materials_ordered',
  'materials_delivered', 'crew_scheduled', 'install_in_progress',
  'warranty_claim', 'warranty_scheduled', 'service_approved'];

// Production stages: the job is sold and not yet installed (stage-roles JOB).
const JOB_STAGES = ['job_created', 'permit_pulled', 'materials_ordered', 'materials_delivered',
  'crew_scheduled', 'install_in_progress'];

const NY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
function nyDate(ms) { return NY_FMT.format(new Date(ms)); }

function stageKey(lead) { return String((lead && (lead._stageKey || lead.stage)) || '').toLowerCase(); }

// ─── after install day ───────────────────────────────────────────

/** The job's last day ('YYYY-MM-DD'), or null when it has no valid date. */
function lastJobDay(lead) {
  const w = SW.normalize(lead || {});
  if (!w) return null;
  return w.endDate || w.date;
}

/**
 * Should the "Mark Install Done? Take After photos." push go out for this lead
 * this morning? Yes when its last job day was YESTERDAY (New York) and it is
 * still in a production stage (not marked done yet, not lost, not deleted).
 */
function afterInstallDue(lead, todayYmd) {
  if (!lead || lead.deleted === true) return false;
  if (!JOB_STAGES.includes(stageKey(lead))) return false;
  const last = lastJobDay(lead);
  return !!last && last === SW.addDays(todayYmd, -1);
}

// ─── signed jobs that need a week ────────────────────────────────

/**
 * Committed jobs with neither a day nor a planned week — "N signed jobs need a
 * week". `jobs` (optional) are a customer's OTHER jobs, each { leadId, ...job
 * fields }; the active job is the lead's own fields.
 */
function needsWeek(leads, jobs) {
  const out = [];
  const byId = new Map();
  for (const l of leads || []) {
    if (!l || !l.id || l.deleted === true) continue;
    byId.set(String(l.id), l);
    if (!COMMITTED.includes(stageKey(l))) continue;
    if (SW.parseYmd(String(l.scheduledDate || '')) || SW.mondayOf(String(l.scheduledWeek || ''))) continue;
    out.push({ leadId: String(l.id), jobId: null, name: `${l.firstName || ''} ${l.lastName || ''}`.trim() || String(l.address || '') || 'Customer', stage: stageKey(l) });
  }
  for (const j of jobs || []) {
    if (!j || !j.leadId || !j.id || j.deleted === true) continue;
    const lead = byId.get(String(j.leadId));
    if (!lead || lead.activeJobId === j.id) continue;
    if (!COMMITTED.includes(stageKey(j))) continue;
    if (SW.parseYmd(String(j.scheduledDate || '')) || SW.mondayOf(String(j.scheduledWeek || ''))) continue;
    out.push({ leadId: String(lead.id), jobId: String(j.id), name: (`${lead.firstName || ''} ${lead.lastName || ''}`.trim() || 'Customer') + (j.title ? ' — ' + j.title : ''), stage: stageKey(j) });
  }
  return out;
}

// ─── weather.gov ─────────────────────────────────────────────────

const WEATHER_HOST = 'https://api.weather.gov';
// weather.gov requires a User-Agent that identifies the app and a contact.
const WEATHER_UA = 'NBD Pro job weather (jd@nobigdealwithjoedeal.com)';
const FORECAST_DAYS = 7;

const finite = (n) => typeof n === 'number' && isFinite(n);

/** A point's cache key: 2 decimals ≈ 1 km, so neighbours share one fetch. */
function gridKey(lat, lng) {
  if (!finite(lat) || !finite(lng)) return null;
  return 'wx_' + lat.toFixed(2) + '_' + lng.toFixed(2);
}

function pointsUrl(lat, lng) {
  return WEATHER_HOST + '/points/' + (+lat).toFixed(4) + ',' + (+lng).toFixed(4);
}

/** '5 to 15 mph' → 15; '10 mph' → 10; anything else → 0. */
function windMax(s) {
  const nums = String(s || '').match(/\d+/g);
  return nums ? Math.max.apply(null, nums.map(Number)) : 0;
}

/** A forecast response → just what the badge needs, per period. */
function slimPeriods(json) {
  const periods = (json && json.properties && Array.isArray(json.properties.periods)) ? json.properties.periods : [];
  return periods.map((p) => ({
    // startTime carries the forecast office's own offset ("…T06:00:00-04:00"),
    // so its first ten characters ARE the local date.
    date: String(p.startTime || '').slice(0, 10),
    day: p.isDaytime !== false,
    name: String(p.name || ''),
    short: String(p.shortForecast || '').slice(0, 80),
    pop: p.probabilityOfPrecipitation && finite(p.probabilityOfPrecipitation.value) ? p.probabilityOfPrecipitation.value : 0,
    wind: windMax(p.windSpeed),
    temp: finite(p.temperature) ? p.temperature : null,
  })).filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date));
}

const SEVERE = /thunder|t-storm|storm|snow|sleet|ice|freez|hail/i;
const WET = /rain|shower|drizzle/i;

/** ok | watch | warn — a roofing day's risk. Warns only; nothing blocks on it. */
function levelFor(d) {
  if (!d) return 'ok';
  if (d.pop >= 50 || SEVERE.test(d.short) || d.wind >= 25) return 'warn';
  if (d.pop >= 30 || WET.test(d.short) || d.wind >= 18) return 'watch';
  return 'ok';
}

/** '60% Showers And Thunderstorms · wind 15 mph' */
function weatherLabel(d) {
  if (!d) return '';
  const bits = [];
  if (d.pop > 0) bits.push(d.pop + '%');
  bits.push(d.short || 'Forecast');
  let s = bits.join(' ');
  if (d.wind >= 15) s += ' · wind ' + d.wind + ' mph';
  return s;
}

/**
 * Periods → one summary per local date: the daytime period (when a roof is
 * open), else the night's. { 'YYYY-MM-DD': { short, pop, wind, temp, level, label } }
 */
function dailySummary(periods) {
  const out = {};
  for (const p of periods || []) {
    const cur = out[p.date];
    if (cur && cur._day && !p.day) continue;              // keep the daytime period
    out[p.date] = { short: p.short, pop: p.pop, wind: p.wind, temp: p.temp, _day: p.day };
  }
  for (const k of Object.keys(out)) {
    const d = out[k];
    delete d._day;
    d.level = levelFor(d);
    d.label = weatherLabel(d);
  }
  return out;
}

/** The job's days within the forecast window [today, today+6]. */
function jobDaysWithin(lead, todayYmd, days) {
  const w = SW.normalize(lead || {});
  if (!w) return [];
  const n = days || FORECAST_DAYS;
  const last = SW.addDays(todayYmd, n - 1);
  const out = [];
  for (let i = 0; i < w.days; i++) {
    const d = SW.addDays(w.date, i);
    if (d >= todayYmd && d <= last) out.push(d);
  }
  return out;
}

function hasPoint(lead) {
  return !!lead && finite(lead.lat) && finite(lead.lng) && Math.abs(lead.lat) <= 90 && Math.abs(lead.lng) <= 180;
}

module.exports = {
  TZ, COMMITTED, JOB_STAGES, WEATHER_HOST, WEATHER_UA, FORECAST_DAYS,
  nyDate, lastJobDay, afterInstallDue, needsWeek,
  gridKey, pointsUrl, windMax, slimPeriods, levelFor, weatherLabel, dailySummary, jobDaysWithin, hasPoint,
};
