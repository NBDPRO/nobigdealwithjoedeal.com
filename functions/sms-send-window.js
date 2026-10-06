/**
 * functions/sms-send-window.js — texting hours in the HOMEOWNER's local time
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE GAP THIS CLOSES (texting review 2026-10-05, fix #3 approved by Jo)
 *
 * Quiet hours existed on two paths only — offline-queue replays
 * (sms-outbox-guard.js) and storm texts (storm-sms-guard.js) — and both read
 * the clock in America/New_York for everyone. A rep could send a live text at
 * 11pm; a door-knock or an approved AI reply went whenever it was approved;
 * and "9pm Eastern" is 8pm in Chicago and 10pm on Florida's own rule.
 *
 * One rule now, for every outbound path: a text to a homeowner goes only
 * between SEND_WINDOW.startHour and SEND_WINDOW.endHour (08:00–21:00, Jo
 * 2026-09-18, sms-outbox-guard.js — the ONE definition of the hours) in the
 * homeowner's local time, ending earlier where the state says so.
 *
 * WHERE IS THE HOMEOWNER? From the record we are texting about, best first:
 *   1. an explicit IANA `tz` on the record (storm subscribers can carry one)
 *   2. a two-letter `state` field
 *   3. a ZIP (`zip` / `zipCode` / `postalCode`) → state by its 3-digit prefix
 *   4. the trailing "…, ST 12345" of a free-text `address`
 * A state that spans zones (KY, TN, IN, FL, MI, TX, KS, NE, ND, SD, ID, OR)
 * must be inside the window in EVERY zone it has — 8am Central is 9am
 * Eastern, so the earliest send to a Kentucky number is 9am Eastern and the
 * latest 9pm Eastern. Unknown location: Eastern, the CRM's home zone and the
 * old behaviour.
 *
 * Pure. Tested in tests/sms-consent-quiet-switch-2026-10-05.test.js.
 */

'use strict';

const { SEND_WINDOW } = require('./sms-outbox-guard');

const ET = 'America/New_York';
const CT = 'America/Chicago';
const MT = 'America/Denver';
const AZ = 'America/Phoenix';
const PT = 'America/Los_Angeles';
const AK = 'America/Anchorage';
const HI = 'Pacific/Honolulu';

/** Every zone a state's homeowners can be in. */
const STATE_ZONES = Object.freeze({
  CT: [ET], DE: [ET], DC: [ET], GA: [ET], ME: [ET], MD: [ET], MA: [ET], NH: [ET],
  NJ: [ET], NY: [ET], NC: [ET], OH: [ET], PA: [ET], RI: [ET], SC: [ET], VT: [ET],
  VA: [ET], WV: [ET],
  FL: [ET, CT], IN: [ET, CT], KY: [ET, CT], MI: [ET, CT], TN: [ET, CT],
  AL: [CT], AR: [CT], IL: [CT], IA: [CT], LA: [CT], MN: [CT], MS: [CT], MO: [CT],
  OK: [CT], WI: [CT],
  KS: [CT, MT], NE: [CT, MT], ND: [CT, MT], SD: [CT, MT], TX: [CT, MT],
  CO: [MT], MT: [MT], NM: [MT], UT: [MT], WY: [MT], AZ: [AZ],
  ID: [MT, PT], OR: [PT, MT],
  CA: [PT], NV: [PT], WA: [PT],
  AK: [AK], HI: [HI],
});

/**
 * States whose own telemarketing-hours rule ends before 9pm (8pm local).
 * Applied as the END hour for that state; the start stays 8am.
 */
const STATE_END_HOUR = Object.freeze({ FL: 20, OK: 20, MD: 20, WA: 20 });

// 3-digit ZIP prefix ranges → state. [low, high, state], inclusive.
const ZIP3 = [
  [5, 5, 'NY'], [10, 27, 'MA'], [28, 29, 'RI'], [30, 38, 'NH'], [39, 49, 'ME'],
  [50, 54, 'VT'], [55, 55, 'MA'], [56, 59, 'VT'], [60, 69, 'CT'], [70, 89, 'NJ'],
  [100, 149, 'NY'], [150, 196, 'PA'], [197, 199, 'DE'], [200, 205, 'DC'],
  [206, 219, 'MD'], [220, 246, 'VA'], [247, 268, 'WV'], [270, 289, 'NC'],
  [290, 299, 'SC'], [300, 319, 'GA'], [320, 339, 'FL'], [341, 349, 'FL'],
  [350, 369, 'AL'], [370, 385, 'TN'], [386, 397, 'MS'], [398, 399, 'GA'],
  [400, 427, 'KY'], [430, 459, 'OH'], [460, 479, 'IN'], [480, 499, 'MI'],
  [500, 528, 'IA'], [530, 549, 'WI'], [550, 567, 'MN'], [569, 569, 'DC'],
  [570, 577, 'SD'], [580, 588, 'ND'], [590, 599, 'MT'], [600, 629, 'IL'],
  [630, 658, 'MO'], [660, 679, 'KS'], [680, 693, 'NE'], [700, 714, 'LA'],
  [716, 729, 'AR'], [730, 732, 'OK'], [733, 733, 'TX'], [734, 749, 'OK'],
  [750, 799, 'TX'], [800, 816, 'CO'], [820, 831, 'WY'], [832, 838, 'ID'],
  [840, 847, 'UT'], [850, 865, 'AZ'], [870, 884, 'NM'], [885, 885, 'TX'],
  [889, 898, 'NV'], [900, 961, 'CA'], [967, 968, 'HI'], [970, 979, 'OR'],
  [980, 994, 'WA'], [995, 999, 'AK'],
];

// Split states, narrowed by ZIP prefix where the prefix is wholly in one zone
// (a state-only record still has to clear every zone the state has). Only
// the prefixes listed here are narrowed; any other ZIP in a split state keeps
// both zones.
const ZIP3_ZONE = Object.freeze({
  // Kentucky: western KY is Central; Northern KY (Cincinnati side), Lexington,
  // Louisville and the east are Eastern.
  400: ET, 401: ET, 402: ET, 403: ET, 404: ET, 405: ET, 406: ET, 407: ET, 408: ET, 409: ET,
  410: ET, 411: ET, 412: ET, 413: ET, 414: ET, 415: ET, 416: ET, 417: ET, 418: ET,
  420: CT, 421: CT, 422: CT, 423: CT, 424: CT,
  // Tennessee: Chattanooga + Knoxville Eastern; Nashville, Memphis, Jackson Central.
  370: CT, 371: CT, 372: CT, 373: ET, 374: ET, 375: CT, 376: ET, 377: ET, 378: ET, 379: ET,
  380: CT, 381: CT, 382: CT, 383: CT, 384: CT, 385: CT,
  // Indiana: Gary / Evansville corners Central; the rest Eastern.
  460: ET, 461: ET, 462: ET, 465: ET, 466: ET, 467: ET, 468: ET, 469: ET,
  470: ET, 471: ET, 472: ET, 473: ET, 474: ET, 475: ET, 478: ET, 479: ET,
  463: CT, 464: CT, 476: CT, 477: CT,
  // Florida: the western Panhandle Central; peninsula Eastern.
  320: ET, 321: ET, 322: ET, 323: ET, 326: ET, 327: ET, 328: ET, 329: ET, 330: ET, 331: ET,
  332: ET, 333: ET, 334: ET, 335: ET, 336: ET, 337: ET, 338: ET, 339: ET, 341: ET, 342: ET,
  344: ET, 346: ET, 347: ET, 349: ET,
  324: CT, 325: CT,
});

function zoneFromZip(zip) {
  const m = String(zip == null ? '' : zip).match(/^\s*(\d{5})(?:-\d{4})?\s*$/);
  return m ? (ZIP3_ZONE[Number(m[1].slice(0, 3))] || '') : '';
}

function stateFromZip(zip) {
  const m = String(zip == null ? '' : zip).match(/^\s*(\d{5})(?:-\d{4})?\s*$/);
  if (!m) return '';
  const p = Number(m[1].slice(0, 3));
  for (const [lo, hi, st] of ZIP3) if (p >= lo && p <= hi) return st;
  return '';
}

function cleanState(s) {
  const v = String(s == null ? '' : s).trim().toUpperCase();
  return STATE_ZONES[v] ? v : '';
}

/** "12 Main St, Goshen, OH 45122" → { state: 'OH', zip: '45122' } (either may be ''). */
function parseAddressTail(address) {
  const a = String(address == null ? '' : address);
  const m = a.match(/\b([A-Za-z]{2})\.?\s+(\d{5})(?:-\d{4})?\s*(?:,?\s*(?:USA|US|United States))?\s*$/);
  if (m && cleanState(m[1])) return { state: cleanState(m[1]), zip: m[2] };
  const z = a.match(/\b(\d{5})(?:-\d{4})?\s*(?:,?\s*(?:USA|US|United States))?\s*$/);
  return { state: '', zip: z ? z[1] : '' };
}

function validTz(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_) { return false; }
}

/**
 * Where (which zones, which hours) a record's homeowner is.
 * @param {object} rec  a lead / knock / storm subscriber (any of tz, state, zip, zipCode, postalCode, address)
 * @returns {{zones: string[], startHour: number, endHour: number, state: string, basis: string}}
 */
function recipientWindow(rec) {
  const r = rec || {};
  const out = (zones, state, basis) => ({
    zones,
    startHour: SEND_WINDOW.startHour,
    endHour: Math.min(SEND_WINDOW.endHour, (state && STATE_END_HOUR[state]) || SEND_WINDOW.endHour),
    state: state || '',
    basis,
  });
  let zip = String(r.zip || r.zipCode || r.postalCode || '').trim();
  let state = cleanState(r.state);
  if (r.address && (!state || !zip)) {
    const t = parseAddressTail(r.address);
    if (!state) state = t.state;
    if (!zip) zip = t.zip;
  }
  const zipState = stateFromZip(zip);
  if (!state) state = zipState;
  if (validTz(r.tz)) return out([r.tz], state, 'tz');
  // A ZIP that agrees with the state (or stands alone) may narrow a split state.
  const zipZone = (!zipState || zipState === state) ? zoneFromZip(zip) : '';
  if (state && zipZone && STATE_ZONES[state].indexOf(zipZone) !== -1) return out([zipZone], state, 'zip');
  if (state) return out(STATE_ZONES[state].slice(), state, 'state');
  return out([SEND_WINDOW.timeZone], '', 'default');
}

function hourIn(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(ms));
  const h = parts.find((p) => p.type === 'hour');
  return h ? Number(h.value) % 24 : NaN;
}

/**
 * May a text go to this record's homeowner at `nowMs`?
 * @returns {{ok: boolean, window: object, localHours: number[]}}
 */
function checkRecipientWindow(nowMs, rec) {
  const window = recipientWindow(rec);
  const localHours = window.zones.map((z) => hourIn(nowMs, z));
  const ok = localHours.length > 0 && localHours.every((h) => Number.isFinite(h)
    && h >= window.startHour && h < window.endHour);
  return { ok, window, localHours };
}

function withinRecipientWindow(nowMs, rec) {
  return checkRecipientWindow(nowMs, rec).ok;
}

/** What the rep is told when a text is refused for the hour. */
function quietHoursMessage(window) {
  const fmt = (h) => (h === 12 ? '12pm' : h > 12 ? (h - 12) + 'pm' : h + 'am');
  return 'Not sent: it is outside texting hours (' + fmt(window.startHour) + '–' + fmt(window.endHour)
    + ' in the homeowner\'s time zone). Send it during those hours.';
}

module.exports = {
  STATE_ZONES,
  STATE_END_HOUR,
  stateFromZip,
  parseAddressTail,
  recipientWindow,
  checkRecipientWindow,
  withinRecipientWindow,
  quietHoursMessage,
};
