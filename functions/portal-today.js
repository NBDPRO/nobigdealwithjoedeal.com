/**
 * functions/portal-today.js — the homeowner portal's install-day "Today" card
 * (2026-11-04, documentation/projects/CUSTOMER-PORTAL-PLAN-2026-11-04.md
 * Phase 2). getHomeownerPortalView adds `view.today` from here.
 *
 * Jo's decisions: the card fills itself from what the CRM already knows plus
 * his optional one-line note; nothing is sent without him. Crew = the crew
 * COMPANY only (the sub's company name from companies/{tenant}/subs/{subId}),
 * never a person's name, phone or photo — so the free-text lead.crew field,
 * which can hold a first name, is deliberately NOT a fallback. Install-day
 * changes are requests (the message box), never self-serve.
 *
 * Weather: the same cached weather.gov forecast the crew board uses
 * (job-weather.js weatherByDay — 2-hour cache, one /points lookup per place).
 * It never blocks the portal: a forecast that takes longer than
 * WEATHER_BUDGET_MS is skipped for this load.
 *
 * Wording rules (KY + crews): no claim / carrier / adjuster words, no "our
 * team". A rainy forecast says the build day MAY move and the rep will say
 * so — never that it has moved (only the date on the lead says that).
 */
'use strict';

const PF = require('./production-flow-logic');
const SW = require('./schedule-window');
// The server's copy of the KY claim-wording rules (kept equal to
// docs/pro/js/claim-wording-filter.js by tests/social-studio-2026-10-04).
const ClaimWording = require('./social-claim-wording');

const NOTE_MAX = 160;
const NOTE_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const WEATHER_BUDGET_MS = 2500;

// ALL customer-facing wording for the card. Edit here, nowhere else.
const TODAY_COPY = Object.freeze({
  headingToday:    'Today at your home',
  headingTomorrow: 'Tomorrow at your home',
  headingSoon:     'Your build day is coming up',
  headingWorking:  'The crew is working on your home',
  crewLine:        '{crew} (independent crew)',
  weatherLabel:    'Forecast',
  weatherWatch:    'Weather to keep an eye on. {rep} will let you know if anything changes.',
  weatherWarn:     'Rain or storms may move your build day. {rep} will tell you if it moves.',
  noteFrom:        'From {rep}',
  changeAsk:       'Need to change something about your build day? Send {rep} a message below.',
});

/** The rep's first name, or 'your rep'. */
function repFirst(name) {
  const f = String(name || '').trim().split(/\s+/)[0];
  return f && f.toLowerCase() !== 'your' ? f : 'your rep';
}

/** A note Jo left for the homeowner, or null (blank, stale, or malformed). */
function noteFor(lead, nowMs) {
  const n = lead && lead.portalNote;
  if (!n || typeof n !== 'object') return null;
  const text = String(n.text || '').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);
  const at = Number(n.atMs);
  if (!text || !Number.isFinite(at) || nowMs - at > NOTE_FRESH_MS || at - nowMs > 60 * 60 * 1000) return null;
  // Belt and braces behind the CRM's own check: a note that trips the KY
  // claim-wording rules never reaches the homeowner.
  try { if (ClaimWording.scanText(text).length) return null; } catch (_) { return null; }
  return { text, atMs: at };
}

/**
 * Pure. The card for this lead, or null when there is nothing to say yet.
 *   opts: { nowMs, crewName, weather: {'YYYY-MM-DD': {level,label}}|null, repName }
 * Shown while the job has a day in the next 7 days, or the stage says the
 * crew is working. A note on its own (no job day) also shows the card.
 */
function todayCard(lead, opts) {
  const o = opts || {};
  const L = lead || {};
  const nowMs = Number.isFinite(o.nowMs) ? o.nowMs : Date.now();
  const today = PF.nyDate(nowMs);
  const w = SW.normalize(L);
  const days = w ? PF.jobDaysWithin(L, today, 7) : [];
  const working = String(L.stage || '').toLowerCase() === 'install_in_progress';
  const note = noteFor(L, nowMs);
  if (!days.length && !working && !note) return null;

  let when;
  if (days.indexOf(today) !== -1) when = 'today';
  else if (working) when = 'working';
  else if (days[0] === SW.addDays(today, 1)) when = 'tomorrow';
  else if (days.length) when = 'soon';
  else when = 'note';

  const weather = [];
  for (const d of days) {
    const s = o.weather && o.weather[d];
    if (s && (s.level === 'ok' || s.level === 'watch' || s.level === 'warn')) weather.push({ date: d, level: s.level, label: String(s.label || '').slice(0, 80) });
  }
  const crew = typeof o.crewName === 'string' && o.crewName.trim() ? o.crewName.trim().slice(0, 60) : null;
  return { when, days, crew, weather, note, rep: repFirst(o.repName) };
}

/**
 * The crew COMPANY name for the lead's sub, or null. Tenant-scoped: only the
 * subs of the tenant the portal token was minted for.
 */
async function crewNameFor(db, lead, tenant) {
  const subId = lead && typeof lead.subId === 'string' ? lead.subId : '';
  if (!subId || !tenant || subId.includes('/') || String(tenant).includes('/')) return null;
  try {
    const s = await db.doc('companies/' + tenant + '/subs/' + subId).get();
    const d = s && s.exists ? s.data() || {} : null;
    const name = d && (d.company || d.companyName || d.name);
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch (_) { return null; }
}

/** Everything the card needs, never throwing and never slow. */
async function loadToday(db, lead, opts) {
  const o = opts || {};
  const nowMs = Number.isFinite(o.nowMs) ? o.nowMs : Date.now();
  const quick = todayCard(lead, { nowMs, repName: o.repName });
  if (!quick) return null;
  const weatherP = (async () => {
    try {
      const JW = o.jobWeather || require('./job-weather')._internal;
      return await Promise.race([
        JW.weatherByDay(db, lead, nowMs),
        new Promise((r) => setTimeout(() => r(null), o.weatherBudgetMs || WEATHER_BUDGET_MS)),
      ]);
    } catch (_) { return null; }
  })();
  const [crewName, weather] = await Promise.all([crewNameFor(db, lead, o.tenant), weatherP]);
  return todayCard(lead, { nowMs, repName: o.repName, crewName, weather });
}

module.exports = { TODAY_COPY, todayCard, noteFor, crewNameFor, loadToday, repFirst, NOTE_MAX, NOTE_FRESH_MS, WEATHER_BUDGET_MS };
